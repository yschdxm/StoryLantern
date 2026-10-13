import type { Disposer } from './types.ts';

type AnyListener = (...args: never[]) => unknown;

/**
 * 事件总线。
 *
 * 两种模式（照搬 DSH 的扩展点强弱分级中「waterfall」这一级）：
 *  - `emit`：并行广播，纯观察，不得改变调用方状态。
 *  - `waterfall`：串行改写。监听器必须自行调用 `next()` 才会继续；
 *    不拥有决策权的监听器必须 `return next()`，否则会静默吞掉后续监听器与默认行为。
 */
export class EventBus {
  readonly #listeners = new Map<string, AnyListener[]>();

  on(event: string, listener: AnyListener): Disposer {
    const list = this.#listeners.get(event);
    if (list) list.push(listener);
    else this.#listeners.set(event, [listener]);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.#listeners.get(event);
      if (!current) return;
      const index = current.indexOf(listener);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.#listeners.delete(event);
    };
  }

  /** 监听器数量，供测试与 inspect 使用。 */
  count(event?: string): number {
    if (event === undefined) {
      let total = 0;
      for (const list of this.#listeners.values()) total += list.length;
      return total;
    }
    return this.#listeners.get(event)?.length ?? 0;
  }

  events(): string[] {
    return [...this.#listeners.keys()].sort();
  }

  /** 并行广播；单个监听器抛错不影响其它监听器，错误聚合后抛出。 */
  async emit(event: string, ...args: unknown[]): Promise<void> {
    const list = [...(this.#listeners.get(event) ?? [])];
    if (list.length === 0) return;
    // 故意用 async 箭头函数包住调用：监听器同步抛出也要变成 rejection，
    // 否则会逃出 allSettled 变成「第一个错误直接中断广播」。
    const results = await Promise.allSettled(list.map(async (listener) => listener(...(args as never[]))));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((f) => f.reason),
        `${event}: ${failures.length} 个监听器失败`,
      );
    }
  }

  /**
   * 串行改写链。监听器签名 `(value, next) => unknown`。
   * 返回值语义：调用过 `next()` 的监听器直接把其结果返回；否则返回自身值（`undefined` 视为不改变）。
   */
  async waterfall<T>(event: string, value: T, context?: unknown): Promise<T> {
    const list = [...(this.#listeners.get(event) ?? [])];
    if (list.length === 0) return value;

    let cursor = -1;
    const dispatch = async (current: T): Promise<T> => {
      cursor += 1;
      const listener = list[cursor] as unknown as (v: T, n: (next?: T) => Promise<T>, c?: unknown) => unknown;
      if (!listener) return current;

      let forwarded = false;
      const next = (nextValue?: T): Promise<T> => {
        forwarded = true;
        return dispatch(nextValue === undefined ? current : nextValue);
      };
      const result = await listener(current, next, context);
      if (forwarded) return (await result) as T;
      return (result === undefined ? current : (result as T));
    };

    return dispatch(value);
  }
}
