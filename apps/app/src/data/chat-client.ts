import { WireClient, WireError, type WireTransport } from '../../../../packages/wire/src/index.ts';
import { DataError } from './repository.ts';

/**
 * 聊天（模型调用）客户端。
 *
 * **只在宿主可用**：请求由 Rust 侧发出，密钥存在宿主数据库里、从不经过前端。
 * 浏览器里没有宿主，因此这里明确报 `no-host`，而不是"静默不回复"或偷偷把 key 放到前端。
 */

export interface ChatDelta {
  /** 占位消息的 id（宿主先落一条 streaming 消息，边收边更新）。 */
  messageId?: number;
  delta: string;
  started?: boolean;
  finished?: boolean;
}

export interface ChatReplyResult {
  messageId?: number;
  text: string;
  aborted: boolean;
}

export interface ChatClient {
  readonly available: boolean;
  reply(
    sessionId: number,
    handlers: { onDelta?: (delta: ChatDelta) => void; signal?: AbortSignal },
  ): Promise<ChatReplyResult>;
  probe(): Promise<{ ok: boolean; message: string }>;
}

export function createChatClient(transport: WireTransport | undefined): ChatClient {
  if (transport === undefined) {
    const error = (): never => {
      throw new DataError('no-host', '浏览器里不能直接调用模型：密钥会落到前端。请用桌面或 Android 版。');
    };
    return {
      available: false,
      async reply() {
        return error();
      },
      async probe() {
        return { ok: false, message: '浏览器里没有宿主，无法测试连接' };
      },
    };
  }

  const client = new WireClient(transport);

  return {
    available: true,

    async reply(sessionId, handlers) {
      const bound = handlers.signal === undefined ? client : client.withSignal(handlers.signal);
      let messageId: number | undefined;
      let text = '';
      try {
        for await (const chunk of bound.stream<ChatDelta>('chat', 'reply', sessionId)) {
          if (typeof chunk.messageId === 'number') messageId = chunk.messageId;
          if (chunk.delta !== '') text += chunk.delta;
          handlers.onDelta?.(chunk);
        }
        return { ...(messageId === undefined ? {} : { messageId }), text, aborted: false };
      } catch (cause) {
        if (cause instanceof WireError && cause.code === 'aborted') {
          return { ...(messageId === undefined ? {} : { messageId }), text, aborted: true };
        }
        if (cause instanceof WireError) throw new DataError(cause.code, cause.message);
        throw cause;
      }
    },

    async probe() {
      try {
        return await client.call<{ ok: boolean; message: string }>('chat', 'probe');
      } catch (cause) {
        if (cause instanceof WireError) return { ok: false, message: cause.message };
        return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  };
}
