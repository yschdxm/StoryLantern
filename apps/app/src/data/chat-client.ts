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
  /** 正文增量。 */
  delta?: string;
  /** 思考链增量（DeepSeek 的 `delta.reasoning_content` / 兼容的 `delta.reasoning`）。 */
  reasoning?: string;
  /** 真实 token 用量（流末尾单独一条 chunk；部分端点可能没有）。 */
  usage?: ChatUsage;
  /** function calling 的原始增量（arguments 可能分片；由客户端按 index 累积）。 */
  toolCalls?: readonly RawToolCallDelta[];
}

/** function calling：请求里声明的工具。 */
export interface ChatToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/** 完整的工具调用（累积后的结果；arguments 是 JSON 字符串）。 */
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** SSE 里的工具调用增量：首包带 id/name，后续只有 arguments 片段。 */
export interface RawToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** `false` = 来自接口的真实用量；`true` = 调用方本地估算。 */
  estimated: boolean;
}

export interface ChatReplyResult {
  text: string;
  /** 思考链全文（与正文分开存：它属于生成元数据，不显示为消息正文）。 */
  reasoning?: string;
  usage?: ChatUsage;
  /** 模型请求的工具调用（已把 arguments 分片拼完整）。 */
  toolCalls?: readonly ChatToolCall[];
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
  /**
   * 历史之后、最后一条 system 注入（宿主把它放在 messages 之后）。
   * 用于"回复前提醒"这类后置指令，不占历史窗口的前部位置。
   */
  postHistory?: string;
  /**
   * 是否向接口要真实 token 用量（`stream_options.include_usage`）。
   * 默认 true；个别不支持的端点会回 400，调用方可显式传 false 关掉。
   */
  includeUsage?: boolean;
  /** function calling：可选工具定义；不给就不带（旧请求字节不变）。 */
  tools?: readonly ChatToolDefinition[];
  /** `auto` / `none`；与 tools 一起发给接口。 */
  toolChoice?: 'auto' | 'none';
  /** 多模型路由：只传 id，密钥由宿主自己取。 */
  profileId?: string;
}

/** 预览：这次调用**会发出去的**请求（URL/请求体/字节数/模型名），不发动网络。 */
export interface ChatPreview {
  url: string;
  body: string;
  byteLength: number;
  model: string;
}

export interface ChatClient {
  readonly available: boolean;
  reply(
    request: ChatCall,
    handlers: { onDelta?: (delta: ChatDelta) => void; signal?: AbortSignal },
  ): Promise<ChatReplyResult>;
  preview(call: ChatCall): Promise<ChatPreview>;
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
      async preview() {
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
      let reasoning = '';
      let usage: ChatUsage | undefined;
      // function calling：按 index 把 arguments 分片拼起来（id/name 只出现在首包）
      const pendingCalls = new Map<number, { id?: string; type?: string; name?: string; args: string }>();
      try {
        for await (const chunk of bound.stream<ChatDelta>('chat', 'reply', request)) {
          const delta = typeof chunk.delta === 'string' ? chunk.delta : '';
          const thought = typeof chunk.reasoning === 'string' ? chunk.reasoning : '';
          if (chunk.usage !== undefined) usage = { ...chunk.usage, estimated: false };
          for (const raw of chunk.toolCalls ?? []) {
            const current = pendingCalls.get(raw.index) ?? { args: '' };
            if (raw.id !== undefined) current.id = raw.id;
            if (raw.type !== undefined) current.type = raw.type;
            if (raw.function?.name !== undefined) current.name = raw.function.name;
            if (raw.function?.arguments !== undefined) current.args += raw.function.arguments;
            pendingCalls.set(raw.index, current);
          }
          if (delta === '' && thought === '' && chunk.usage === undefined && (chunk.toolCalls?.length ?? 0) === 0) continue;
          if (delta !== '') text += delta;
          if (thought !== '') reasoning += thought;
          handlers.onDelta?.(chunk);
        }
        const toolCalls: ChatToolCall[] = [...pendingCalls.entries()]
          .sort(([left], [right]) => left - right)
          .map(([index, call]) => ({
            id: call.id ?? `call_${index}`,
            type: 'function',
            function: { name: call.name ?? '', arguments: call.args },
          }));
        return {
          text,
          ...(reasoning === '' ? {} : { reasoning }),
          ...(usage === undefined ? {} : { usage }),
          ...(toolCalls.length === 0 ? {} : { toolCalls }),
          aborted: false,
        };
      } catch (cause) {
        if (cause instanceof WireError && cause.code === 'aborted') {
          return {
            text,
            ...(reasoning === '' ? {} : { reasoning }),
            ...(usage === undefined ? {} : { usage }),
            aborted: true,
          };
        }
        if (cause instanceof WireError) throw new DataError(cause.code, cause.message);
        throw cause;
      }
    },

    async preview(call) {
      try {
        return await client.call<ChatPreview>('chat', 'preview', call);
      } catch (cause) {
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
