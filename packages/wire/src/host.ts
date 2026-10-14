import type { Disposer } from '../../plugin-api/src/contract.ts';
import {
  WireError,
  type WireInvokeRequest,
  type WireManifest,
  type WireMethodDescriptor,
  type WireMethodKind,
  type WireServiceManifest,
} from './transport.ts';

/**
 * 宿主侧：把 Service 的方法暴露给客户端。
 *
 * 约定（与内核的"注册即 effect"一致）：
 *  - `expose()` 返回 disposer，Service 卸载时它的远端方法一并消失；
 *  - 处理器最后多收一个 `{ signal }`，用于取消长任务；
 *  - 流式方法必须返回 AsyncIterable，且**必须在中断时停止产出**（否则取消形同虚设）。
 */
export type WireHandler = (...args: never[]) => unknown;

export interface ExposeOptions {
  description?: string;
  /** 单个方法的元信息；没写的一律按 `call` 处理。 */
  methods?: Record<string, { kind?: WireMethodKind; description?: string }>;
}

interface RegisteredService {
  description?: string;
  handlers: Record<string, WireHandler>;
  methods: Map<string, WireMethodDescriptor>;
  active: boolean;
}

export class WireHost {
  readonly #services = new Map<string, RegisteredService>();
  #pendingId = 0;

  get nextRequestId(): string {
    this.#pendingId += 1;
    return `w${this.#pendingId}`;
  }

  expose(service: string, handlers: Record<string, WireHandler>, options: ExposeOptions = {}): Disposer {
    if (this.#services.has(service)) {
      throw new WireError('duplicate-service', `Service '${service}' 已经暴露过了`, { service });
    }

    const methods = new Map<string, WireMethodDescriptor>();
    for (const [name, handler] of Object.entries(handlers)) {
      if (typeof handler !== 'function') continue;
      const meta = options.methods?.[name];
      methods.set(name, {
        name,
        kind: meta?.kind ?? 'call',
        ...(meta?.description === undefined ? {} : { description: meta.description }),
      });
    }

    const record: RegisteredService = {
      handlers,
      methods,
      active: true,
      ...(options.description === undefined ? {} : { description: options.description }),
    };
    this.#services.set(service, record);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      record.active = false;
      if (this.#services.get(service) === record) this.#services.delete(service);
    };
  }

  /** 供 Inspect/界面使用：客户端能调用的全部方法与类型。 */
  manifest(): WireManifest {
    const services: WireServiceManifest[] = [...this.#services.entries()]
      .map(([name, record]) => ({
        name,
        ...(record.description === undefined ? {} : { description: record.description }),
        methods: [...record.methods.values()].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { services };
  }

  get size(): number {
    return this.#services.size;
  }

  async *invoke(request: WireInvokeRequest): AsyncIterable<unknown> {
    const { service, method, args, signal } = request;
    const record = this.#services.get(service);
    if (!record || !record.active) {
      throw new WireError('unknown-service', `未知 Service '${service}'`, { service, method });
    }
    const descriptor = record.methods.get(method);
    const handler = record.handlers[method];
    if (!descriptor || typeof handler !== 'function') {
      throw new WireError('unknown-method', `Service '${service}' 没有方法 '${method}'`, { service, method });
    }
    if (signal?.aborted) {
      throw new WireError('aborted', `调用在开始前已被取消：${service}.${method}`, { service, method });
    }

    const call = handler as unknown as (...params: unknown[]) => unknown;

    if (descriptor.kind === 'call') {
      try {
        yield await call(...args, { signal });
      } catch (error) {
        throw wrap(error, service, method);
      }
      return;
    }

    // 流式：把 AsyncIterable 逐项转发，并在中断时立刻抛出（不静默截断）。
    let produced: unknown;
    try {
      produced = call(...args, { signal });
    } catch (error) {
      throw wrap(error, service, method);
    }
    if (produced === null || typeof produced !== 'object' || !(Symbol.asyncIterator in produced)) {
      throw new WireError('bad-stream', `${service}.${method} 声明为流式，但没有返回 AsyncIterable`, { service, method });
    }

    const iterator = (produced as AsyncIterable<unknown>)[Symbol.asyncIterator]();
    try {
      for (;;) {
        if (signal?.aborted) {
          await iterator.return?.(undefined);
          throw new WireError('aborted', `流式调用被取消：${service}.${method}`, { service, method });
        }
        const next = await iterator.next();
        if (next.done === true) return;
        yield next.value;
      }
    } catch (error) {
      if (error instanceof WireError) throw error;
      throw wrap(error, service, method);
    } finally {
      if (signal?.aborted) await iterator.return?.(undefined);
    }
  }
}

function wrap(error: unknown, service: string, method: string): WireError {
  if (error instanceof WireError) return error;
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return new WireError(typeof code === 'string' ? code : 'handler-failed', error.message, { service, method });
  }
  return new WireError('handler-failed', String(error), { service, method });
}
