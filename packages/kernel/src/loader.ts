import type { Context } from './context.ts';
import { activatePlugin, ActivationTracker } from './plugin.ts';
import { resolveJsExpressions } from './yaml.ts';

export interface ResolvedEntry {
  id: string;
  name: string;
  config: Record<string, unknown>;
  disabled: boolean;
  /** 产生该行最终形态的来源（bundle 包名或 patch 文件名），用于诊断。 */
  source: string;
}

export interface PatchOptions {
  /** `!!js` 表达式可见的变量（例如 `{ ctx }`）。 */
  scope?: Record<string, unknown>;
  /** 是否允许求值 `!!js`（本地 profile 默认允许；来自不可信渠道时必须关闭）。 */
  allowJs?: boolean;
}

/**
 * 组合：一系列按层应用的 patch。
 *
 * 方言（照搬 DSH 的 loader 语义）：
 *  - patch 文件顶层是数组；
 *  - `- insert: [ {id, name, config} ]` 插入行；
 *  - 带 `id` 的行覆盖同 id 已有行（**整体替换 config，不做深合并**）；
 *  - 未匹配到 id 的覆盖行按「新增」处理并记 warning（向前兼容，绝不静默吞掉配置）。
 */
export class Composition {
  readonly #rows = new Map<string, ResolvedEntry>();
  readonly #order: string[] = [];
  readonly #warnings: string[] = [];

  get warnings(): readonly string[] {
    return this.#warnings;
  }

  applyPatch(patch: unknown, source: string, options: PatchOptions = {}): void {
    if (patch === null || patch === undefined) return;
    if (!Array.isArray(patch)) {
      this.#warnings.push(`${source}: patch 顶层必须是数组，实际 ${typeof patch}`);
      return;
    }
    for (const row of patch) this.#applyRow(row, source, options, false);
  }

  entries(): ResolvedEntry[] {
    return this.#order.map((id) => this.#rows.get(id)).filter((row): row is ResolvedEntry => row !== undefined);
  }

  enabled(): ResolvedEntry[] {
    return this.entries().filter((row) => !row.disabled);
  }

  get(id: string): ResolvedEntry | undefined {
    return this.#rows.get(id);
  }

  get size(): number {
    return this.#rows.size;
  }

  #applyRow(row: unknown, source: string, options: PatchOptions, fromInsert: boolean): void {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      this.#warnings.push(`${source}: 行必须是 map，已跳过`);
      return;
    }
    const record = row as Record<string, unknown>;

    if (Array.isArray(record.insert)) {
      for (const child of record.insert) this.#applyRow(child, source, options, true);
    }

    const id = record.id;
    if (typeof id === 'string' && id !== '') {
      this.#upsert(id, record, source, options, fromInsert);
      return;
    }
    if (!Array.isArray(record.insert)) {
      this.#warnings.push(`${source}: 行既没有 id 也没有 insert，已跳过`);
    }
  }

  #upsert(
    id: string,
    record: Record<string, unknown>,
    source: string,
    options: PatchOptions,
    fromInsert: boolean,
  ): void {
    const existing = this.#rows.get(id);
    const scope = options.scope ?? {};
    const allowJs = options.allowJs ?? true;

    let config: Record<string, unknown> | undefined;
    if (record.config !== undefined) {
      const resolved = resolveJsExpressions(record.config, scope, { allowJs });
      for (const warning of resolved.warnings) this.#warnings.push(`${source} [${id}]: ${warning}`);
      config = (resolved.value ?? {}) as Record<string, unknown>;
    }

    let disabled: boolean | undefined;
    if (record.disabled !== undefined) {
      const resolved = resolveJsExpressions(record.disabled, scope, { allowJs });
      for (const warning of resolved.warnings) this.#warnings.push(`${source} [${id}]: ${warning}`);
      disabled = resolved.value === true;
    }

    const name = typeof record.name === 'string' ? record.name : existing?.name ?? id;
    const entry: ResolvedEntry = {
      id,
      name,
      config: config ?? existing?.config ?? {},
      disabled: disabled ?? existing?.disabled ?? false,
      source,
    };

    if (!existing) {
      this.#order.push(id);
      if (!fromInsert) {
        this.#warnings.push(`${source}: 覆盖了不存在的行 '${id}'，已按新增处理`);
      }
      if (typeof record.name !== 'string') {
        this.#warnings.push(`${source}: 新增行 '${id}' 未提供 name，无法解析插件包`);
      }
    } else if (record.name === undefined && record.config === undefined && record.disabled === undefined) {
      this.#warnings.push(`${source}: 覆盖行 '${id}' 没有任何可覆盖字段`);
    }

    this.#rows.set(id, entry);
  }
}

export interface CompositionLayer {
  source: string;
  rows: unknown;
  options?: PatchOptions;
}

/** 按顺序叠加多层 patch：bundle patch → 用户 patch → 命令行 overlay。 */
export function composeProfile(layers: readonly CompositionLayer[]): Composition {
  const composition = new Composition();
  for (const layer of layers) composition.applyPatch(layer.rows, layer.source, layer.options ?? {});
  return composition;
}

export interface CompositionHost {
  resolve(name: string): unknown | Promise<unknown>;
}

export interface ActivateCompositionOptions {
  tracker?: ActivationTracker;
  logger?: { error(message: string, error?: unknown): void };
}

/** 激活组合并返回台账；返回前会 `settle()`，因此结果反映依赖注入后的最终状态。 */
export async function activateComposition(
  ctx: Context,
  composition: Composition,
  host: CompositionHost,
  options: ActivateCompositionOptions = {},
): Promise<ActivationTracker> {
  const tracker = options.tracker ?? new ActivationTracker();

  for (const entry of composition.entries()) {
    if (entry.disabled) {
      tracker.record({ id: entry.id, name: entry.name, status: 'disabled', reason: `来自 ${entry.source} 的 disabled` });
      continue;
    }
    let module: unknown;
    try {
      module = await host.resolve(entry.name);
    } catch (error) {
      tracker.record({
        id: entry.id,
        name: entry.name,
        status: 'failed',
        reason: `无法解析插件包：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    await activatePlugin(ctx, {
      id: entry.id,
      name: entry.name,
      plugin: module,
      config: entry.config,
      tracker,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  }

  await ctx.settle();
  return tracker;
}
