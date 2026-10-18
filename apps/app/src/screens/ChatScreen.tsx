import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createDefaultLocalOpPorts, createWireOpPorts } from '../data/op-ports.ts';
import { createDeviceRequestLog, type RequestLogEntry } from '../data/request-log.ts';
import { describeError } from '../data/error-text.ts';
import { formatTime, isModelConfigured } from '../data/repository.ts';
import { loadWorkspace, type WorkspaceSnapshot } from '../app/workspace.ts';
import { useT } from '../i18n/context.tsx';
import type { ScreenProps } from './screen-props.ts';
import { useAppState, useAsync } from './screen-props.ts';
import { isCharacterCard } from '../../../../packages/cards/src/index.ts';
import { expandQuickReply, listQuickReplies } from '../data/quick-replies.ts';
import { regexStatOf, transformUserInput } from '../data/chat-regex.ts';
import { Banner, Button, LoadMore, Sheet, SheetItem, useWindowedList } from '../ui/components.tsx';
import { RequestTracePanel } from './RequestTracePanel.tsx';
import { MessageContent, StreamingContent } from './chat/MessageBubble.tsx';
import { MessageDetail } from './chat/MessageDetail.tsx';
import { AgentLauncher } from './agent/AgentLauncher.tsx';
import { MessageEditSheet } from './chat/MessageEditSheet.tsx';
import { MessageRevisionsSheet } from './chat/MessageRevisionsSheet.tsx';
import { useChatReply } from './chat/use-chat-reply.ts';

export interface ChatScreenProps extends ScreenProps {
  sessionId: string;
  onOpenSettings: () => void;
}

/**
 * 聊天页。
 *
 * 三段式布局：顶栏（外壳）· 消息滚动区 · 底部输入栏。
 * 回复流程（装配/预览/多模型回退/流式/引用/落库 meta）在 `chat/use-chat-reply.ts`；
 * 气泡里的思考链、引用 chip、消息详情在 `chat/MessageBubble.tsx` 与 `chat/MessageDetail.tsx`。
 */
export function ChatScreen({ store, sessionId, chat, assemble, onOpenSettings, transport }: ChatScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const session = state.sessions.find((item) => item.id === sessionId);
  const [draft, setDraft] = useState('');
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | undefined>(undefined);
  const [traceOpen, setTraceOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [pickerFor, setPickerFor] = useState<string | undefined>(undefined);
  const [detailFor, setDetailFor] = useState<string | undefined>(undefined);
  const [editingFor, setEditingFor] = useState<string | undefined>(undefined);
  const [versionsFor, setVersionsFor] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heightBeforeRef = useRef(0);
  // B25：请求审计只在本机设备 kv（不新增全局单例）；浏览器/宿主复用同一份端口实现。
  const requestLog = useMemo(
    () =>
      createDeviceRequestLog(
        (transport === undefined ? createDefaultLocalOpPorts() : createWireOpPorts(transport)).device,
      ),
    [transport],
  );
  const [history, setHistory] = useState<RequestLogEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | undefined>(undefined);

  useAsync(() => store.actions.loadMessages(sessionId), [sessionId, store]);
  /** 本会话的卡片设定视图（开局配置 / 卡片 / 运行时）：聊天页自己取，避免塞进全局状态。 */
  useAsync(async () => {
    setWorkspace(await loadWorkspace(store.repository, store.getState(), sessionId));
  }, [sessionId, store, state.characters, state.lorebooks]);

  const reply = useChatReply({ store, sessionId, chat, assemble, transport, workspace, requestLog });
  const { streaming, chatError, injectedLore, trace } = reply;
  const { visible, hidden, sentinel } = useWindowedList(state.messages, { pageSize: 40, from: 'end' });

  const configured = isModelConfigured(state.settings);
  const canReply = chat.available;
  const candidateCount =
    menuFor === undefined ? 0 : (state.messages.find((message) => message.id === menuFor)?.candidates.length ?? 0);
  const detailMessage = detailFor === undefined ? undefined : state.messages.find((message) => message.id === detailFor);
  const editingMessage = editingFor === undefined ? undefined : state.messages.find((message) => message.id === editingFor);
  const versionsMessage = versionsFor === undefined ? undefined : state.messages.find((message) => message.id === versionsFor);
  const menuMessage = menuFor === undefined ? undefined : state.messages.find((message) => message.id === menuFor);
  const sourceOf = (messageId: string): string | undefined =>
    state.messages.find((message) => message.id === messageId)?.content;

  // B14：快捷回复来自本会话激活的角色卡；只填输入框，不直接发送。
  const quickReplyCards = useMemo(() => (workspace?.cards ?? []).filter(isCharacterCard), [workspace]);
  const quickReplies = useMemo(
    () =>
      listQuickReplies(
        quickReplyCards,
        workspace?.setup?.characters ?? quickReplyCards.map((card) => card.meta.id),
      ),
    [quickReplyCards, workspace?.setup?.characters],
  );
  const quickReplyChar = session?.characterName ?? quickReplyCards[0]?.meta.name ?? '';
  const quickReplyUser = workspace?.setup?.user_role ?? '';
  const insertQuickReply = (content: string): void => {
    setDraft(
      expandQuickReply(content, {
        ...(quickReplyChar === '' ? {} : { char: quickReplyChar }),
        ...(quickReplyUser === '' ? {} : { user: quickReplyUser }),
      }),
    );
  };

  // 打开 Inspector 或一次生成结束时刷新审计列表；失败要看得见，不静默吞
  useEffect(() => {
    if (!traceOpen) return;
    let alive = true;
    void requestLog
      .list()
      .then((entries) => {
        if (!alive) return;
        setHistory(entries);
        setHistoryError(undefined);
      })
      .catch((cause: unknown) => {
        if (alive) setHistoryError(describeError(cause));
      });
    return () => {
      alive = false;
    };
  }, [traceOpen, requestLog, trace?.totalMs]);

  const clearHistory = async (): Promise<void> => {
    try {
      await requestLog.clear();
      setHistory(await requestLog.list());
      setHistoryError(undefined);
    } catch (cause) {
      setHistoryError(describeError(cause));
    }
  };

  // 在提交前记录滚动高度：向前加载历史后要补偿，否则视野会跳
  heightBeforeRef.current = scrollRef.current?.scrollHeight ?? heightBeforeRef.current;
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    const delta = node.scrollHeight - heightBeforeRef.current;
    if (delta > 0) node.scrollTop += delta;
    heightBeforeRef.current = node.scrollHeight;
  }, [hidden]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [state.messages.length, streaming?.text, streaming?.reasoning, sessionId]);

  const send = (): void => {
    const text = draft.trim();
    if (text === '' || streaming !== null) return;
    setDraft('');
    void (async () => {
      // B13：user_input 正则只转换本次输入；统计进消息 meta（不静默）
      const outgoing = transformUserInput(text, workspace?.cards ?? [], workspace?.setup);
      const regexStat = regexStatOf('user_input', outgoing);
      await store.actions.send(sessionId, outgoing.text, regexStat === undefined ? {} : { regex: [regexStat] }).catch(() => undefined);
      if (!configured || !canReply) return;
      await reply.runReply();
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
      <AgentLauncher store={store} chat={chat} requestLog={requestLog} settings={state.settings} sessionId={sessionId} />

      <div className="chat__scroll" ref={scrollRef}>
        {state.messages.length === 0 && streaming === null ? (
          <p className="chat__hint">{t('chat.empty', { name: session?.characterName ?? '' })}</p>
        ) : (
          <>
            <LoadMore hidden={hidden} sentinel={sentinel} />
            <ul className="chat__list">
              {visible.map((message) => (
                <li key={message.id} className={`msg msg--${message.role}`}>
                  <div
                    className="msg__bubble"
                    role="button"
                    tabIndex={0}
                    onClick={() => setMenuFor(message.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setMenuFor(message.id);
                    }}
                    aria-label={t('chat.messageActions', { id: message.id })}
                  >
                    <MessageContent message={message} sourceOf={sourceOf} />
                  </div>
                  <span className="msg__meta">
                    {message.status === 'streaming'
                      ? t('chat.streaming')
                      : message.status === 'stopped'
                        ? t('chat.stopped')
                        : message.status === 'error'
                          ? t('chat.failed')
                          : formatTime(message.createdAt)}
                  </span>
                </li>
              ))}
              {streaming !== null && (
                <li className="msg msg--assistant">
                  <span className="msg__bubble">
                    <StreamingContent text={streaming.text} reasoning={streaming.reasoning} />
                  </span>
                  <span className="msg__meta">{t('chat.streaming')}</span>
                </li>
              )}
            </ul>
          </>
        )}
      </div>

      {quickReplies.length > 0 && (
        <div className="quick-replies" role="group" aria-label={t('chat.quickReplies.label')} data-testid="quick-replies">
          {quickReplies.map((reply) => (
            <button
              key={reply.id}
              type="button"
              className="quick-reply-chip"
              title={reply.name}
              onClick={() => insertQuickReply(reply.content)}
            >
              {reply.name}
            </button>
          ))}
        </div>
      )}

      <div className="composer">
        <textarea
          className="composer__input"
          data-testid="chat-input"
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
          <Button variant="danger" onClick={() => reply.abort()}>
            {t('chat.stop')}
          </Button>
        ) : (
          <Button disabled={!configured || !chat.available || draft.trim() === ''} onClick={send} testId="chat-send">
            {t('chat.send')}
          </Button>
        )}
      </div>

      <Sheet open={menuFor !== undefined} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="book"
          label={t('chat.detail.action')}
          onClick={() => {
            const id = menuFor;
            setMenuFor(undefined);
            if (id !== undefined) setDetailFor(id);
          }}
        />
        <SheetItem
          icon="edit"
          label={t('chat.edit.action')}
          onClick={() => {
            const id = menuFor;
            setMenuFor(undefined);
            if (id !== undefined) setEditingFor(id);
          }}
        />
        <SheetItem
          icon="book"
          label={t('chat.revisions.action', { count: menuMessage?.revisionCount ?? 1 })}
          onClick={() => {
            const id = menuFor;
            setMenuFor(undefined);
            if (id !== undefined) setVersionsFor(id);
          }}
        />
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

      <MessageDetail
        message={detailMessage}
        sourceOf={sourceOf}
        open={detailFor !== undefined}
        onClose={() => setDetailFor(undefined)}
      />

      <MessageEditSheet
        message={editingMessage}
        onClose={() => setEditingFor(undefined)}
        onSave={async (content) => {
          if (editingFor === undefined) return false;
          const changed = await store.actions.editMessage(editingFor, content);
          if (changed) await store.actions.loadMessages(sessionId);
          return changed;
        }}
      />
      <MessageRevisionsSheet
        store={store}
        message={versionsMessage}
        onClose={() => setVersionsFor(undefined)}
        onSelect={async (revisionId) => {
          if (versionsFor === undefined) return false;
          const changed = await store.actions.selectMessageRevision(versionsFor, revisionId);
          if (changed) await store.actions.loadMessages(sessionId);
          return changed;
        }}
      />

      <RequestTracePanel
        open={traceOpen}
        state={trace}
        modelLabel={trace?.attempts.find((attempt) => attempt.ok)?.label ?? store.getState().settings['model.name'] ?? '—'}
        onClose={() => setTraceOpen(false)}
        history={history}
        historyError={historyError}
        onClearHistory={() => void clearHistory()}
      />
    </div>
  );
}
