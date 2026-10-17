import { WireClient, WireError, type WireTransport } from '../../../../packages/wire/src/index.ts';
import { describeError } from './error-text.ts';
import { DataError } from './repository.ts';
import type { ChatPromptMessage } from './tokens.ts';

/**
 * 聊天（模型调用）客户端。
 *
 * **只在宿主可用**：请求由 Rust 发出，密钥存在宿主设置里、从不经过前端；
 * 上下文由前端组装（见 `prompt-v2.ts`），宿主只负责把分片转回来。
 */

export interface ChatDelta {
  delta: string;
}

export interface ChatReplyResult {
  text: string;
  aborted: boolean;
}

/**
 * 一次模型调用真正需要的东西。
 *
 * 刻意**不是** `ChatRequest`：宿主只关心"发什么"与"用哪份配置"，
 * 世界书/记忆/可解释性痕迹都是应用侧的东西，不该出现在这一层。
 * 这样摘要、抽取这些**非聊天**的调用也能复用同一个客户端。
 */
export interface ChatCall {
  messages: ChatPromptMessage[];
  systemPrompt?: string;
  /** 多模型路由：只传 id，密钥由宿主自己取。 */
  profileId?: string;
}

export interface ChatClient {
  readonly available: boolean;
  reply(
    request: ChatCall,
    handlers: { onDelta?: (delta: ChatDelta) => void; signal?: AbortSignal },
  ): Promise<ChatReplyResult>;
  probe(profileId?: string): Promise<{ ok: boolean; message: string }>;
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

    async probe(profileId?: string) {
      try {
        return await client.call<{ ok: boolean; message: string }>('chat', 'probe', {
          ...(profileId === undefined || profileId === '' ? {} : { profileId }),
        });
      } catch (cause) {
        if (cause instanceof WireError) return { ok: false, message: cause.message };
        return { ok: false, message: describeError(cause) };
      }
    },
  };
}
