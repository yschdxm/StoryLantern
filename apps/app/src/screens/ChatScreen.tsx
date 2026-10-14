import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useAppState, useAsync } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import { formatTime, isModelConfigured } from '../data/repository.ts';
import { buildChatRequest } from '../data/prompt.ts';
import { candidatesFor, targetLabel } from '../data/model-routing.ts';
import type { ChatReplyResult } from '../data/chat-client.ts';
import type { ScoredEntry } from '../../../../packages/lore/src/index.ts';
import { Banner, Button, LoadMore, Sheet, SheetItem, useWindowedList } from '../ui/components.tsx';
import { RequestTracePanel, type ModelAttempt, type RequestTraceState } from './RequestTracePanel.tsx';


export interface ChatScreenProps extends ScreenProps {
  sessionId: string;
  onOpenSettings: () => void;
}

/**
 * 聊天页。
 *
 * 三段式布局：顶栏（外壳）· 消息滚动区 · 底部输入栏。
 * 三处细节决定"像不像原生"：
 *  1. 输入栏跟随键盘（visualViewport），不是被键盘盖住；
 *  2. 新消息到达自动贴底，但**往上翻看历史时不打断**；
 *  3. 历史很长时只渲染最近一屏多一点，翻到顶再往前加载（窗口化），万条消息也不卡。
 */
export function ChatScreen({ store, sessionId, chat, assemble, onOpenSettings }: ChatScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const session = state.sessions.find((item) => item.id === sessionId);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<{ text: string } | null>(null);
  const [chatError, setChatError] = useState<string | undefined>(undefined);
  /** 上一次请求实际注入的世界书条目（空 = 没命中）。 */
  const [injectedLore, setInjectedLore] = useState<ScoredEntry[]>([]);
  /** 上一次请求的构成说明 + 耗时（可解释性面板）。 */
  const [trace, setTrace] = useState<RequestTraceState | undefined>(undefined);
  const [traceOpen, setTraceOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [composerOffset, setComposerOffset] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const heightBeforeRef = useRef(0);

  useAsync(() => store.actions.loadMessages(sessionId), [sessionId, store]);

  const { visible, hidden, sentinel } = useWindowedList(state.messages, { pageSize: 40, from: 'end' });

  const configured = isModelConfigured(state.settings);
  const canReply = chat.available;

  // 在提交前记录滚动高度：向前加载历史后要补偿，否则视野会跳
  heightBeforeRef.current = scrollRef.current?.scrollHeight ?? heightBeforeRef.current;

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const delta = node.scrollHeight - heightBeforeRef.current;
    if (delta > 0) node.scrollTop += delta;
    heightBeforeRef.current = node.scrollHeight;
  }, [hidden]);

  // 新消息 / 生成内容变化时贴底
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [state.messages.length, streaming?.text, sessionId]);

  // 键盘弹出时把输入栏顶上去（visualViewport 是移动端唯一可靠的高度来源）
  useEffect(() => {
    const viewport = (globalThis as { visualViewport?: VisualViewport }).visualViewport;
    if (viewport === undefined) return;
    const update = (): void => {
      const hiddenByKeyboard = Math.max(0, globalThis.innerHeight - viewport.height - viewport.offsetTop);
      setComposerOffset(hiddenByKeyboard);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

  const runReply = async (): Promise<void> => {
    // 用 store 里的**最新**状态组上下文：刚发出去的那条消息要进上下文
    const fresh = store.getState();
    const current = fresh.sessions.find((item) => item.id === sessionId);
    const character = fresh.characters.find((item) => item.id === current?.characterId);
    const request = buildChatRequest({
      settings: fresh.settings,
      ...(character === undefined ? {} : { character }),
      history: fresh.messages.map((message) => ({ role: message.role, content: message.content, status: message.status })),
      // 世界书：全局的 + 绑定到这个角色的（按角色筛完再交给扫描器）
      lorebooks: fresh.lorebooks.filter(
        (book) => book.enabled && (book.characterIds.length === 0 || (character !== undefined && book.characterIds.includes(character.id))),
      ),
      // 长期记忆：同样是全局的 + 绑定到这个角色的
      memories: fresh.memories.filter(
        (memory) => memory.characterId === '' || (character !== undefined && memory.characterId === character.id),
      ),
      // 系统提示交给组装管线：优先级 / 预算 / 每条理由都在那里算
      ...(assemble === undefined ? {} : { assemble }),
      sessionTitle: current?.title ?? '',
    });
    // 注入痕迹：用户随时能看到"这次模型多看了哪几条设定"（可解释性的最小一步）
    setInjectedLore(request.lore);
    setTrace({ trace: request.trace, startedAt: Date.now(), attempts: [] });
    const startedAt = Date.now();
    let firstDeltaAt: number | undefined;

    // 多模型路由：按任务排出候选（顺序即回退链），一个不行就换下一个
    const candidates = candidatesFor(fresh.settings, 'chat');
    const attempts: ModelAttempt[] = [];

    const controller = new AbortController();
    controllerRef.current = controller;
    setChatError(undefined);
    setStreaming({ text: '' });
    try {
      if (candidates.length === 0) {
        throw new Error(t('chat.noModel'));
      }

      let outcome: ChatReplyResult | undefined;
      for (const candidate of candidates) {
        // 换一个候选时把上一段的半截输出清掉：它不属于最终回复
        setStreaming({ text: '' });
        const attemptStarted = Date.now();
        try {
          outcome = await chat.reply(
            { ...request, ...(candidate.id === '' ? {} : { profileId: candidate.id }) },
            {
              signal: controller.signal,
              onDelta: (delta) => {
                if (delta.delta === '') return;
                if (firstDeltaAt === undefined) firstDeltaAt = Date.now();
                setStreaming((state) => ({ text: (state?.text ?? '') + delta.delta }));
              },
            },
          );
          attempts.push({ label: targetLabel(candidate), ok: true, ms: Date.now() - attemptStarted });
          break;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          attempts.push({ label: targetLabel(candidate), ok: false, ms: Date.now() - attemptStarted, error: message });
          // 用户点了停止：不要"帮他"再试下一个
          if (controller.signal.aborted) throw cause;
        }
      }
      setTrace((current) => (current === undefined ? current : { ...current, attempts }));

      if (outcome === undefined) {
        throw new Error(attempts[attempts.length - 1]?.error ?? t('chat.noModel'));
      }

      // 生成结果落成 op（宿主不再写库：它只负责转发）
      if (outcome.text !== '') {
        await store.actions.appendMessage(sessionId, 'assistant', outcome.text, outcome.aborted ? { status: 'error' } : {});
      }
      setTrace((current) =>
        current === undefined
          ? current
          : {
              ...current,
              ...(firstDeltaAt === undefined ? {} : { firstDeltaMs: firstDeltaAt - startedAt }),
              totalMs: Date.now() - startedAt,
            },
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setChatError(message);
      setTrace((current) => (current === undefined ? current : { ...current, attempts, totalMs: Date.now() - startedAt }));
      // 失败也留痕：写成一条失败消息，用户看得见、也能删
      await store.actions
        .appendMessage(sessionId, 'assistant', message, { status: 'error' })
        .catch(() => undefined);
    } finally {
      controllerRef.current = null;
      setStreaming(null);
      await store.actions.loadMessages(sessionId).catch(() => undefined);
      await store.actions.refreshSessions().catch(() => undefined);
    }
  };

  const send = (): void => {
    const text = draft.trim();
    if (text === '' || streaming !== null) return;
    setDraft('');
    void (async () => {
      await store.actions.send(sessionId, text).catch(() => undefined);
      if (!configured || !canReply) return;
      await runReply();
    })();
  };

  const banner = ((): { tone: 'warn' | 'error'; text: string; action?: ReactNode } | undefined => {
    if (!chat.available) return { tone: 'warn', text: t('chat.noHost') };
    if (!configured) {
      return {
        tone: 'warn',
        text: t('chat.unconfigured'),
        action: (
          <Button variant="ghost" onClick={onOpenSettings}>
            {t('chat.goSettings')}
          </Button>
        ),
      };
    }
    return undefined;
  })();

  return (
    <div className="chat" style={{ paddingBottom: composerOffset }}>
      {banner !== undefined && (
        <Banner tone={banner.tone} {...(banner.action === undefined ? {} : { action: banner.action })}>
          {banner.text}
        </Banner>
      )}
      {chatError !== undefined && <Banner tone="error">{chatError}</Banner>}
      {injectedLore.length > 0 && (
        <Banner tone="info">
          {t('chat.lore', {
            count: injectedLore.length,
            keys: injectedLore
              .map((entry) => entry.matchedKeys.join('、'))
              .filter((keys) => keys !== '')
              .slice(0, 3)
              .join(' / '),
          })}
        </Banner>
      )}
      {/* 可解释性入口：点开就是"这次模型到底看到了什么" */}
      {trace !== undefined && (
        <button type="button" className="chat__trace-link" onClick={() => setTraceOpen(true)}>
          {t('chat.trace.open')}
        </button>
      )}

      <div className="chat__scroll" ref={scrollRef}>
        {state.messages.length === 0 && streaming === null ? (
          <p className="chat__hint">{t('chat.empty', { name: session?.characterName ?? '' })}</p>
        ) : (
          <>
            <LoadMore hidden={hidden} sentinel={sentinel} />
            <ul className="chat__list">
              {visible.map((message) => (
                <li key={message.id} className={`msg msg--${message.role}`}>
                  <button
                    type="button"
                    className="msg__bubble"
                    onClick={() => setMenuFor(message.id)}
                    aria-label={t('chat.messageActions', { id: message.id })}
                  >
                    <span className="msg__text">{message.content === '' ? '…' : message.content}</span>
                  </button>
                  <span className="msg__meta">
                    {message.status === 'streaming'
                      ? t('chat.streaming')
                      : message.status === 'error'
                        ? t('chat.failed')
                        : formatTime(message.createdAt)}
                  </span>
                </li>
              ))}
              {streaming !== null && (
                <li className="msg msg--assistant">
                  <span className="msg__bubble">
                    <span className="msg__text">{streaming.text === '' ? '…' : streaming.text}</span>
                  </span>
                  <span className="msg__meta">{t('chat.streaming')}</span>
                </li>
              )}
            </ul>
          </>
        )}
      </div>

      <div className="composer">
        <textarea
          className="composer__input"
          value={draft}
          rows={1}
          placeholder={configured && chat.available ? t('chat.placeholder') : t('chat.placeholder.unconfigured')}
          disabled={!configured || !chat.available || streaming !== null}
          onChange={(event) => setDraft(event.target.value)}
          onInput={(event) => {
            const node = event.currentTarget;
            node.style.height = 'auto';
            node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
          }}
        />
        {streaming !== null ? (
          <Button variant="danger" onClick={() => controllerRef.current?.abort()}>
            {t('chat.stop')}
          </Button>
        ) : (
          <Button disabled={!configured || !chat.available || draft.trim() === ''} onClick={send}>
            {t('chat.send')}
          </Button>
        )}
      </div>

      <Sheet open={menuFor !== undefined} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="trash"
          label={t('chat.deleteMessage')}
          danger
          onClick={() => {
            const id = menuFor;
            setMenuFor(undefined);
            if (id !== undefined) void store.actions.removeMessage(id);
          }}
        />
      </Sheet>

      <RequestTracePanel
        open={traceOpen}
        state={trace}
        modelLabel={
          trace?.attempts.find((attempt) => attempt.ok)?.label ?? store.getState().settings['model.name'] ?? '—'
        }
        onClose={() => setTraceOpen(false)}
      />
    </div>
  );
}
