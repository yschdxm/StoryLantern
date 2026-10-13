import type { Disposer } from './types.ts';

export interface RegistryEntry<T> {
  id: string;
  value: T;
  /** 注册者（插件 id），用于 inspect 与冲突诊断。 */
  owner?: string;
}

/**
 * 通用注册表。所有可扩展点（LLM provider、上下文块、检索源、Agent 工具、
 * 同步后端、UI 槽位、导入导出格式…）都是它的实例：`register` 返回 disposer。
 *
 * 重复 id 默认报错——静默覆盖会让用户在两份配置之间无所适从，
 * 需要覆盖语义时应使用 `Registry.override`。
 */
export class Registry<T> {
  readonly #entries = new Map<string, RegistryEntry<T>>();
  readonly #onDuplicate: 'throw' | 'replace';

  constructor(options: { onDuplicate?: 'throw' | 'replace' } = {}) {
    this.#onDuplicate = options.onDuplicate ?? 'throw';
  }

  register(id: string, value: T, options: { owner?: string } = {}): Disposer {
    if (this.#entries.has(id) && this.#onDuplicate === 'throw') {
      throw new Error(`注册表冲突：id '${id}' 已存在`);
    }

    const entry: RegistryEntry<T> = { id, value };
    if (options.owner !== undefined) entry.owner = options.owner;
    this.#entries.set(id, entry);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.#entries.get(id) === entry) this.#entries.delete(id);
    };
  }

  get(id: string): T | undefined {
    return this.#entries.get(id)?.value;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  list(): RegistryEntry<T>[] {
    return [...this.#entries.values()];
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** 某注册表项的唯一性约束：`id` 即名字，冲突即错误。 */
export function defineRegistry<T>(): Registry<T> {
  return new Registry<T>();
}
