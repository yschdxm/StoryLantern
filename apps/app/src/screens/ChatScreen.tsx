import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { describeError } from '../data/error-text.ts';
import type { ScreenProps } from './screen-props.ts';
import { useAppState, useAsync } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import { formatTime, isModelConfigured } from '../data/repository.ts';
import { buildChatRequestV2 } from '../data/prompt-v2.ts';
import { estimateTokens } from '../data/prompt.ts';
import { buildChatOptionsV2 } from './chat-request.ts';
import { loadWorkspace, type WorkspaceSnapshot } from '../app/workspace.ts';
import { computeUsage } from '../../../../packages/oplog/src/index.ts';
import { createUsageStore } from '../data/usage-store.ts';
import { selectSummariesForChat } from '../data/summary-vector-select.ts';
import { SETTING_KEYS } from '../data/types.ts';
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
export function ChatScreen({ store, sessionId, chat, assemble, onOpenSettings, transport }: ChatScreenProps): ReactNode {
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
  /** 正在看候选回复的消息（swipes：同一条消息的多次生成）。 */
  const [pickerFor, setPickerFor] = useState<string | undefined>(undefined);
  /** 长按消息时它有多少候选（swipes），决定菜单里要不要出现"备选回复"。 */
  const candidateCount =
    menuFor === undefined ? 0 : (state.messages.find((message) => message.id === menuFor)?.candidates.length ?? 0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const heightBeforeRef = useRef(0);

  useAsync(() => store.actions.loadMessages(sessionId), [sessionId, store]);
  /** 本会话的卡片设定视图（开局配置 / 卡片 / 运行时）：聊天页自己取，避免塞进全局状态。 */
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | undefined>(undefined);
  useAsync(async () => {
    setWorkspace(await loadWorkspace(store.repository, store.getState(), sessionId));
  }, [sessionId, store, state.characters, state.lorebooks]);

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


  const runReply = async (): Promise<void> => {
    // 用 store 里的**最新**状态组上下文：刚发出去的那条消息要进上下文
    const fresh = store.getState();
    // 检索（M4）：块渲染同步、embedding 异步 —— 所以检索必须在装配**之前**算好（见 selectSummariesForChat）。
    const usage = createUsageStore({ settings: () => store.getState().settings, setSetting: (key, value) => store.actions.setSetting(key, value) }); const allSummaries = await store.actions.summariesOf(sessionId);
    const preselected = await selectSummariesForChat({ onOutcome: (outcome) => void store.actions.setSetting(SETTING_KEYS.vectorOutcome, JSON.stringify({ ...outcome, at: Date.now() })),
      transport,
      ...(candidatesFor(fresh.settings, 'chat')[0]?.id === undefined ? {} : { profileId: candidatesFor(fresh.settings, 'chat')[0]?.id }),
      model: fresh.settings[SETTING_KEYS.embeddingModel],
      rerankModel: fresh.settings[SETTING_KEYS.rerankModel],
      messages: fresh.messages,
      summaries: allSummaries,
      recordUsage: async (call) => {
        await usage.record(fresh.settings['device.id'] ?? 'unknown', computeUsage({ at: Date.now(), task: 'embed', modelId: call.modelId, promptTokens: call.promptTokens, completionTokens: 0, prices: usage.prices().value }));
      },
    });
    // 卡片模型（ADR-0011）：装配输入是"开局配置 + 本会话卡片 + 运行时"，不再是角色的 6 个文本字段
    const request = buildChatRequestV2(
      buildChatOptionsV2({
        state: fresh,
        sessionId,
        workspace: workspace ?? (await loadWorkspace(store.repository, fresh, sessionId)),
        summaries: allSummaries,
        ...(preselected === undefined ? {} : { preselectedSummaries: preselected }),
        ...(assemble === undefined ? {} : { assemble }),
      }),
    );
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

      // 预算闸门（M4 判据 3）：**发送前**判定。估算刻意取上界（输出按 max_tokens 估），
      // 宁可高估、也不能让用户在不知不觉中超支。价格按**配置 id** 匹配（见 usage-store 的说明）。
      const promptTokens =
        request.trace.usedTokens + estimateTokens(request.messages.map((message) => message.content).join(String.fromCharCode(10)));
      const maxOutputRaw = Number(fresh.settings[SETTING_KEYS.maxTokens] ?? '');
      const maxOutput = Number.isFinite(maxOutputRaw) && maxOutputRaw > 0 ? maxOutputRaw : 1024;
      const estimatedUsd = usage.estimateCost(candidates[0]?.id ?? '', promptTokens, maxOutput);
      const budget = usage.gate(estimatedUsd);
      if (!budget.ok) {
        throw new Error(
          t('chat.overBudget', {
            spent: budget.spentUsd.toFixed(4),
            estimate: estimatedUsd.toFixed(4),
            total: (budget.spentUsd + estimatedUsd).toFixed(4),
          }),
        );
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
          // 记用量：**不记的话 spentUsd 永远是 0，闸门就是摆设**。口径是估算（不是账单）。
          await usage
            .record(
              fresh.settings['device.id'] ?? 'unknown',
              computeUsage({
                at: Date.now(),
                task: 'chat',
                modelId: candidate.id === '' ? 'default' : candidate.id,
                promptTokens,
                completionTokens: estimateTokens(outcome.text),
                prices: usage.prices().value,
              }),
            )
            .catch(() => undefined);
          break;
        } catch (cause) {
          const message = describeError(cause);
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
      const message = describeError(cause);
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
    <div className="chat">
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
        {candidateCount > 0 && (
          <SheetItem
            icon="edit"
            label={t('chat.candidates.action', { count: candidateCount })}
            onClick={() => {
              const id = menuFor;
              setMenuFor(undefined);
              setPickerFor(id);
            }}
          />
        )}
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

      {/* 候选回复（swipes）：选中的那条成为这条消息的正文 */}
      <Sheet open={pickerFor !== undefined} title={t('chat.candidates.title')} onClose={() => setPickerFor(undefined)}>
        {(state.messages.find((message) => message.id === pickerFor)?.candidates ?? []).map((candidate) => (
          <SheetItem
            key={candidate.id}
            icon="edit"
            label={candidate.content.length > 60 ? `${candidate.content.slice(0, 60)}…` : candidate.content}
            onClick={() => {
              const messageId = pickerFor;
              setPickerFor(undefined);
              if (messageId !== undefined) void store.actions.selectCandidate(messageId, candidate.id);
            }}
          />
        ))}
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
