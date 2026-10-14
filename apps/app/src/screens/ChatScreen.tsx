import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useAppState, useAsync } from './screen-props.ts';
import { formatTime, isModelConfigured } from '../data/repository.ts';
import { SETTING_KEYS } from '../data/types.ts';
import { Banner, Button, Sheet, SheetItem } from '../ui/components.tsx';

export interface ChatScreenProps extends ScreenProps {
  sessionId: number;
  onOpenSettings: () => void;
}

/**
 * 聊天页。
 *
 * 布局三段式：顶栏（外壳）· 消息滚动区 · 底部输入栏。
 * 生成时把宿主推来的分片实时画在气泡里；宿主同时在数据库里更新同一条消息，
 * 所以"停下来"或"失败"都不会丢掉已经看到的内容。
 */
export function ChatScreen({ store, sessionId, chat, onOpenSettings }: ChatScreenProps): ReactNode {
  const state = useAppState(store);
  const session = state.sessions.find((item) => item.id === sessionId);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState<{ text: string } | null>(null);
  const [chatError, setChatError] = useState<string | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<number | undefined>(undefined);
  const [composerOffset, setComposerOffset] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useAsync(() => store.actions.loadMessages(sessionId), [sessionId, store]);

  const baseUrl = state.settings[SETTING_KEYS.baseUrl] ?? '';
  const configured = isModelConfigured(state.settings);
  const canReply = chat.available;

  // 新内容出现就滚到底：聊天最忌讳"新消息在下面看不见"
  useEffect(() => {
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [state.messages.length, streaming?.text, sessionId]);

  // 键盘弹出时把输入栏顶上去（visualViewport 是移动端唯一可靠的高度来源）
  useEffect(() => {
    const viewport = (globalThis as { visualViewport?: VisualViewport }).visualViewport;
    if (viewport === undefined) return;
    const update = (): void => {
      const hidden = Math.max(0, globalThis.innerHeight - viewport.height - viewport.offsetTop);
      setComposerOffset(hidden);
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
    const controller = new AbortController();
    controllerRef.current = controller;
    setChatError(undefined);
    setStreaming({ text: '' });
    try {
      await chat.reply(sessionId, {
        signal: controller.signal,
        onDelta: (delta) => {
          if (delta.delta === '') return;
          setStreaming((current) => ({ text: (current?.text ?? '') + delta.delta }));
        },
      });
    } catch (cause) {
      setChatError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      controllerRef.current = null;
      setStreaming(null);
      // 以库里的真实内容为准（宿主已经把分片写进去了）
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
    if (!chat.available) {
      return { tone: 'warn', text: '浏览器里不调用模型（密钥会落到前端）。请用桌面或 Android 版。' };
    }
    if (!configured) {
      return {
        tone: 'warn',
        text: '还没有配置模型，暂时不能生成回复',
        action: (
          <Button variant="ghost" onClick={onOpenSettings}>
            去配置
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

      <div className="chat__scroll" ref={scrollRef}>
        {state.messages.length === 0 && streaming === null ? (
          <p className="chat__hint">{session?.characterName ?? '角色'} 还没有说话，先从下面发一句试试。</p>
        ) : (
          <ul className="chat__list">
            {state.messages.map((message) => (
              <li key={message.id} className={`msg msg--${message.role}`}>
                <button
                  type="button"
                  className="msg__bubble"
                  onClick={() => setMenuFor(message.id)}
                  aria-label={`第 ${message.id} 条消息的操作`}
                >
                  <span className="msg__text">{message.content === '' ? '…' : message.content}</span>
                </button>
                <span className="msg__meta">
                  {message.status === 'streaming' ? '生成中…' : message.status === 'error' ? '失败' : formatTime(message.createdAt)}
                </span>
              </li>
            ))}
            {streaming !== null && (
              <li className="msg msg--assistant">
                <span className="msg__bubble">
                  <span className="msg__text">{streaming.text === '' ? '…' : streaming.text}</span>
                </span>
                <span className="msg__meta">生成中…</span>
              </li>
            )}
          </ul>
        )}
      </div>

      <div className="composer">
        <textarea
          className="composer__input"
          value={draft}
          rows={1}
          placeholder={configured && chat.available ? '说点什么…' : '先到设置里配置模型'}
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
            停止
          </Button>
        ) : (
          <Button disabled={!configured || !chat.available || draft.trim() === ''} onClick={send}>
            发送
          </Button>
        )}
      </div>

      <Sheet open={menuFor !== undefined} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="trash"
          label="删除这条消息"
          danger
          onClick={() => {
            const id = menuFor;
            setMenuFor(undefined);
            if (id !== undefined) void store.actions.removeMessage(id);
          }}
        />
      </Sheet>
    </div>
  );
}
