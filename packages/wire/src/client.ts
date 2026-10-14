import type { Disposer } from '../../plugin-api/src/contract.ts';
import {
  WireError,
  type WireInvokeRequest,
  type WireManifest,
  type WireMethodKind,
  type WireTransport,
} from './transport.ts';

export interface WireClientOptions {
  /** 全局取消信号：绑定到界面生命周期（例如面板卸载）。 */
  signal?: AbortSignal;
  /** 清单里没声明的方法按什么处理；默认当普通调用。 */
  defaultKind?: WireMethodKind;
}

export interface CallOptions {
  signal?: AbortSignal;
}

/**
 * 客户端：把远端的 Service 当成普通对象用。
 *
 * 关键点：**清单驱动**。`ready()` 之后 `service<T>()` 知道哪些方法是流式，
 * 于是同一份调用代码在"进程内直连"和"HTTP/SSE"上行为一致；
 * 调用不存在的方法会在本地立刻报错（`unknown-method`），而不是等一个无意义的往返。
 */
export class WireClient {
  readonly #transport: WireTransport;
  readonly #options: WireClientOptions;
  #manifest: WireManifest | undefined;
  #manifestLoaded = false;

  constructor(transport: WireTransport, options: WireClientOptions = {}) {
    this.#transport = transport;
    this.#options = options;
  }

  get transportKind(): string {
    return this.#transport.kind;
  }

  /** 预取清单（可选；不调用也能用，只是流式方法会被当成普通调用）。 */
  async ready(): Promise<WireManifest | undefined> {
    if (!this.#manifestLoaded) {
      this.#manifestLoaded = true;
      this.#manifest = await this.#transport.manifest?.();
    }
    return this.#manifest;
  }

  /**
   * 绑定一个取消信号，返回新的客户端（共享传输与已加载的清单）。
   * 用它是为了让"取消"有一个显式入口：`client.withSignal(signal).stream(...)`，
   * 而不是把信号混进方法参数里——那会污染被调用方法的签名。
   */
  withSignal(signal: AbortSignal): WireClient {
    const next = new WireClient(this.#transport, { ...this.#options, signal });
    next.#manifestLoaded = this.#manifestLoaded;
    next.#manifest = this.#manifest;
    return next;
  }

  manifest(): WireManifest | undefined {
    return this.#manifest;
  }

  kindOf(service: string, method: string): WireMethodKind | undefined {
    const descriptor = this.#manifest?.services
      .find((item) => item.name === service)
      ?.methods.find((item) => item.name === method);
    return descriptor?.kind;
  }

  #assertKnown(service: string, method: string): void {
    if (this.#manifest === undefined) return; // 没有清单就没法本地校验，交给对端
    const target = this.#manifest.services.find((item) => item.name === service);
    if (!target) throw new WireError('unknown-service', `未知 Service '${service}'`, { service, method });
    if (!target.methods.some((item) => item.name === method)) {
      throw new WireError('unknown-method', `Service '${service}' 没有方法 '${method}'`, { service, method });
    }
  }

  #request(service: string, method: string, args: unknown[], options: CallOptions = {}): WireInvokeRequest {
    const signal = options.signal ?? this.#options.signal;
    return {
      service,
      method,
      args,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  /** 普通调用：必须恰好产出一个值。 */
  async call<T>(service: string, method: string, ...args: unknown[]): Promise<T> {
    this.#assertKnown(service, method);
    const iterator = this.#transport.invoke(this.#request(service, method, args))[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) {
      throw new WireError('empty-response', `${service}.${method} 没有返回任何值`, { service, method });
    }
    // 多产出的值对普通调用是契约违背：明确报错而不是静默丢弃。
    const extra = await iterator.next();
    if (extra.done !== true) {
      throw new WireError('unexpected-stream', `${service}.${method} 返回了多个值，但它不是流式方法`, { service, method });
    }
    return first.value as T;
  }

  /** 流式调用：逐个产出，直到对端结束或取消。 */
  stream<T>(service: string, method: string, ...args: unknown[]): AsyncIterable<T> {
    this.#assertKnown(service, method);
    const transport = this.#transport;
    const request = this.#request(service, method, args);
    const self = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        const iterator = transport.invoke(request)[Symbol.asyncIterator]();
        void self;
        return {
          async next(): Promise<IteratorResult<T>> {
            const result = await iterator.next();
            return result.done === true ? { done: true, value: undefined } : { done: false, value: result.value as T };
          },
          async return(value?: unknown): Promise<IteratorResult<T>> {
            await iterator.return?.(value);
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  /**
   * 把某个 Service 包装成"像本地对象"的门面。
   * 流式方法返回 `AsyncIterable`，其它方法返回 `Promise`（依据清单）。
   */
  service<T extends object>(name: string, options: CallOptions = {}): T {
    const client = this;
    return new Proxy({} as T, {
      get(_target, property) {
        if (typeof property !== 'string') return undefined;
        return (...args: unknown[]) => {
          const kind = client.kindOf(name, property) ?? client.#options.defaultKind ?? 'call';
          return kind === 'stream' ? client.stream(name, property, ...args) : client.call(name, property, ...args);
        };
      },
    });
  }
}

export interface MemoryPairOptions {
  host: { invoke(request: WireInvokeRequest): AsyncIterable<unknown>; manifest(): WireManifest };
  /** 人为延迟（毫秒），用于在测试里复现乱序/超时。 */
  latencyMs?: number;
  /** 传输层故障注入：每次调用前抛错。 */
  faults?: { offline?: boolean };
}

export interface MemoryPair {
  clientTransport: WireTransport;
  /** 关闭这条传输；之后的所有调用都会以 `transport-closed` 失败。 */
  close(): void;
}

/**
 * 进程内直连。这不是"假的传输"——它实现的是同一个 `WireTransport`，
 * 因此界面在 M0 用直连，之后换 Tauri IPC 或 HTTP/SSE 时调用方代码不变。
 */
export function createMemoryPair(options: MemoryPairOptions): MemoryPair {
  let closed = false;
  const delay = options.latencyMs ?? 0;

  const transport: WireTransport = {
    kind: 'memory',
    async manifest() {
      return options.host.manifest();
    },
    async *invoke(request) {
      if (closed) throw new WireError('transport-closed', '传输已关闭', request);
      if (options.faults?.offline === true) throw new WireError('transport-offline', '传输离线', request);
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      yield* options.host.invoke(request);
    },
  };

  return {
    clientTransport: transport,
    close() {
      closed = true;
    },
  };
}
