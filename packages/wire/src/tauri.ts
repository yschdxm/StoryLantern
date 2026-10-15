import { WireError, type WireInvokeRequest, type WireManifest, type WireTransport } from './transport.ts';
import { describeError } from '../../sync-core/src/error-text.ts';

/**
 * Tauri IPC 承载。
 *
 * 两条路径，宿主侧一一对应（`apps/shell/src-tauri/src/wire.rs`）：
 *
 *  **Channel（首选）**：JS 建一个 Channel 作为 invoke 参数传进去，Rust 侧 `channel.send(...)` 逐片推。
 *    Tauri v2 官方推荐的"Rust → JS 流式"就是这条，且**不经过事件系统的 ACL**。
 *    消息形状：`{ value }` 分片 / `{ done: true }` 结束 / `{ error: {code,message} }` 失败。
 *
 *  **Event（回退）**：桥没有 Channel 能力时，用 `invoke('wire_stream_open')` 拿 streamId，
 *    再 `listen('wire-chunk' | 'wire-end')` 收事件，取消时 `wire_stream_close`。
 *
 * 普通调用两条路共用：`invoke('wire_invoke', ...)`，`Ok(value)` 直接 resolve，
 * `Err({code,message})` reject。
 *
 * 为什么保留事件回退：它验证过"事件通道需要 capability 才允许 listen"，在受限环境下更好排障；
 * 而且它把"分片"与"结束"分成两种事件，语义边界更清楚。
 */

/** 只需要这两三个能力，方便测试注入假桥；真实环境由 `window.__TAURI__` 提供。 */
export interface TauriBridge {
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<() => void>;
  /** 可选：Tauri v2 的 `Channel`。有它走 Channel 路径。 */
  createChannel?<T = unknown>(onMessage: (message: T) => void): unknown;
}

export interface TauriTransportOptions {
  bridge: TauriBridge;
  kind?: string;
}

interface OpenResult {
  streamId?: string;
  error?: { code: string; message: string };
}

interface ChunkPayload {
  streamId: string;
  value: unknown;
}

interface EndPayload {
  streamId: string;
  error?: { code: string; message: string };
}

type StreamMessage = { value?: unknown; done?: boolean; error?: { code: string; message: string } };

function methodKindOf(manifest: WireManifest | undefined, service: string, method: string): 'call' | 'stream' {
  const descriptor = manifest?.services.find((item) => item.name === service)?.methods.find((item) => item.name === method);
  return descriptor?.kind === 'stream' ? 'stream' : 'call';
}

/** 把"看起来像错误载荷"的东西识别出来：`{code, message}`。 */
function asErrorShape(cause: unknown): { code: string; message: string } | undefined {
  if (typeof cause !== 'object' || cause === null) return undefined;
  const record = cause as { code?: unknown; message?: unknown };
  if (typeof record.code === 'string' && typeof record.message === 'string') {
    return { code: record.code, message: record.message };
  }
  return undefined;
}

/** 分片/结束的到达与等待：两条路径共用的一个小队列。 */
function createInbox() {
  const queue: unknown[] = [];
  let finished = false;
  let failure: { code: string; message: string } | undefined;
  let wake: (() => void) | undefined;

  const ping = (): void => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };

  return {
    push(value: unknown): void {
      queue.push(value);
      ping();
    },
    finish(error?: { code: string; message: string }): void {
      finished = true;
      failure = error;
      ping();
    },
    drain(): unknown[] {
      const items = [...queue];
      queue.length = 0;
      return items;
    },
    get done(): boolean {
      return finished;
    },
    get error(): { code: string; message: string } | undefined {
      return failure;
    },
    async wait(signal?: AbortSignal): Promise<void> {
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  };
}

export function createTauriTransport(options: TauriTransportOptions): WireTransport {
  const { bridge } = options;
  let manifest: WireManifest | undefined;
  let manifestFailed = false;

  const loadManifest = async (): Promise<WireManifest | undefined> => {
    if (manifest !== undefined || manifestFailed) return manifest;
    try {
      manifest = await bridge.invoke<WireManifest>('wire_manifest');
    } catch {
      // 拿不到清单不算致命：退化成"全部当普通调用"，由宿主判定
      manifestFailed = true;
    }
    return manifest;
  };

  const callOnce = async (request: WireInvokeRequest): Promise<unknown> => {
    try {
      return await bridge.invoke('wire_invoke', {
        service: request.service,
        method: request.method,
        args: request.args,
      });
    } catch (cause) {
      const shaped = asErrorShape(cause);
      if (shaped !== undefined) {
        throw new WireError(shaped.code, shaped.message, { service: request.service, method: request.method });
      }
      throw new WireError('transport-failed', describeError(cause), {
        service: request.service,
        method: request.method,
      });
    }
  };

  /** 首选：Channel 路径。 */
  async function* streamViaChannel(request: WireInvokeRequest): AsyncIterable<unknown> {
    const inbox = createInbox();
    const channel = bridge.createChannel?.<StreamMessage>((message) => {
      if (message.error !== undefined) inbox.finish(message.error);
      else if (message.done === true) inbox.finish();
      else inbox.push(message.value);
    });
    if (channel === undefined) throw new WireError('no-channel', '桥不支持 Channel', request);

    let streamId: string | undefined;
    const opened = await bridge.invoke<OpenResult>('wire_stream_open', {
      service: request.service,
      method: request.method,
      args: request.args,
      onEvent: channel,
    }).catch((cause: unknown) => {
      const shaped = asErrorShape(cause);
      if (shaped !== undefined) throw new WireError(shaped.code, shaped.message, { service: request.service, method: request.method });
      throw new WireError('transport-failed', describeError(cause), { service: request.service, method: request.method });
    });
    if (opened.error !== undefined) {
      throw new WireError(opened.error.code, opened.error.message, { service: request.service, method: request.method });
    }
    streamId = opened.streamId;

    try {
      for (;;) {
        for (const value of inbox.drain()) yield value;
        if (inbox.error !== undefined) {
          throw new WireError(inbox.error.code, inbox.error.message, { service: request.service, method: request.method });
        }
        if (inbox.done) return;
        if (request.signal?.aborted === true) {
          throw new WireError('aborted', `流式调用被取消：${request.service}.${request.method}`, {
            service: request.service,
            method: request.method,
          });
        }
        await inbox.wait(request.signal);
      }
    } finally {
      if (streamId !== undefined) {
        await bridge.invoke('wire_stream_close', { streamId }).catch(() => undefined);
      }
    }
  }

  /** 回退：事件路径。 */
  async function* streamViaEvents(request: WireInvokeRequest): AsyncIterable<unknown> {
    const inbox = createInbox();
    let streamId: string | undefined;
    /**
     * **先订阅、后开流**：宿主的流可能在我们拿到 streamId 之前就发完（极短流、或立刻失败），
     * 那种事件一旦错过，迭代器就会永远等下去。所以在未知 streamId 期间先存进 `pending`，
     * 开流成功后按 id 回放；不属于本流的早到事件直接丢弃（因此缓冲是有界的）。
     */
    const pending: Array<{ kind: 'chunk' | 'end'; payload: ChunkPayload | EndPayload }> = [];

    const offChunk = await bridge.listen<ChunkPayload>('wire-chunk', (payload) => {
      if (streamId === undefined) {
        pending.push({ kind: 'chunk', payload });
        return undefined;
      }
      if (payload.streamId !== streamId) return undefined;
      inbox.push(payload.value);
      return undefined;
    });
    const offEnd = await bridge.listen<EndPayload>('wire-end', (payload) => {
      if (streamId === undefined) {
        pending.push({ kind: 'end', payload });
        return undefined;
      }
      if (payload.streamId !== streamId) return undefined;
      inbox.finish(payload.error);
      return undefined;
    });

    try {
      const opened = await bridge.invoke<OpenResult>('wire_stream_open', {
        service: request.service,
        method: request.method,
        args: request.args,
      }).catch((cause: unknown) => {
        const shaped = asErrorShape(cause);
        if (shaped !== undefined) throw new WireError(shaped.code, shaped.message, { service: request.service, method: request.method });
        throw new WireError('transport-failed', describeError(cause), { service: request.service, method: request.method });
      });
      if (opened.error !== undefined) {
        throw new WireError(opened.error.code, opened.error.message, { service: request.service, method: request.method });
      }
      if (typeof opened.streamId !== 'string' || opened.streamId === '') {
        throw new WireError('bad-stream', `${request.service}.${request.method} 没有返回 streamId`, request);
      }
      streamId = opened.streamId;

      for (const item of pending) {
        if (item.payload.streamId !== streamId) continue;
        if (item.kind === 'chunk') inbox.push((item.payload as ChunkPayload).value);
        else inbox.finish((item.payload as EndPayload).error);
      }
      pending.length = 0;

      for (;;) {
        for (const value of inbox.drain()) yield value;
        if (inbox.error !== undefined) {
          throw new WireError(inbox.error.code, inbox.error.message, { service: request.service, method: request.method });
        }
        if (inbox.done) return;
        if (request.signal?.aborted === true) {
          throw new WireError('aborted', `流式调用被取消：${request.service}.${request.method}`, {
            service: request.service,
            method: request.method,
          });
        }
        await inbox.wait(request.signal);
      }
    } finally {
      offChunk();
      offEnd();
      if (streamId !== undefined) {
        await bridge.invoke('wire_stream_close', { streamId }).catch(() => undefined);
      }
    }
  }

  return {
    kind: options.kind ?? 'tauri-ipc',
    manifest: loadManifest,
    async *invoke(request) {
      const current = await loadManifest();
      if (methodKindOf(current, request.service, request.method) === 'stream') {
        yield* bridge.createChannel === undefined ? streamViaEvents(request) : streamViaChannel(request);
        return;
      }
      yield await callOnce(request);
    },
  };
}

/** 从运行时的全局对象里取 Tauri 桥；不在 Tauri 里则返回 undefined。 */
export function createTauriBridgeFromGlobal(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): TauriBridge | undefined {
  const tauri = scope['__TAURI__'] as
    | { core?: { invoke?: unknown; Channel?: unknown }; event?: { listen?: unknown } }
    | undefined;
  const invoke = tauri?.core?.invoke;
  const listen = tauri?.event?.listen;
  if (typeof invoke !== 'function' || typeof listen !== 'function') return undefined;

  const invokeFn = invoke as (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  const listenFn = listen as (event: string, handler: (payload: unknown) => void) => Promise<() => void>;
  const ChannelCtor = tauri?.core?.Channel as (new () => { onmessage: (message: unknown) => void }) | undefined;

  return {
    invoke: <T>(command: string, args?: Record<string, unknown>) => invokeFn(command, args) as Promise<T>,
    listen: <T>(event: string, handler: (payload: T) => void) => listenFn(event, handler as (payload: unknown) => void),
    ...(typeof ChannelCtor !== 'function'
      ? {}
      : {
          createChannel: <T>(onMessage: (message: T) => void) => {
            const channel = new ChannelCtor();
            channel.onmessage = onMessage as (message: unknown) => void;
            return channel;
          },
        }),
  };
}
