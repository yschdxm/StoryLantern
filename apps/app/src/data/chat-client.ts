import { WireClient, WireError, type WireTransport } from '../../../../packages/wire/src/index.ts';
import { DataError } from './repository.ts';
import type { ChatRequest } from './prompt.ts';

/**
 * 聊天（模型调用）客户端。
 *
 * **只在宿主可用**：请求由 Rust 发出，密钥存在宿主设置里、从不经过前端；
 * 上下文由前端组装（见 `prompt.ts`），宿主只负责把分片转回来。
 */

export interface ChatDelta {
  delta: string;
}

export interface ChatReplyResult {
  text: string;
  aborted: boolean;
}

export interface ChatClient {
  readonly available: boolean;
  reply(
    request: ChatRequest,
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

    async reply(request, handlers) {
      const bound = handlers.signal === undefined ? client : client.withSignal(handlers.signal);
      let text = '';
      try {
        for await (const chunk of bound.stream<ChatDelta>('chat', 'reply', request)) {
          if (typeof chunk.delta === 'string' && chunk.delta !== '') {
            text += chunk.delta;
            handlers.onDelta?.(chunk);
          }
        }
        return { text, aborted: false };
      } catch (cause) {
        if (cause instanceof WireError && cause.code === 'aborted') return { text, aborted: true };
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
