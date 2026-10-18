/**
 * 块的**预算与来源元数据**（B20 / B21）。
 *
 * 为什么单独成文件：`prompt-blocks-v2.ts` 已贴着 400 行门禁，而这两块信息只被
 * `defineBlock` / `renderAllSections` 读取；集中在这里还能让"默认预算表"只有一处真相。
 *
 * **预算表来源**：不是规范数字，是按当前块内容量的经验值（角色卡最长、世界书次之，
 * 场景/物品偏短），目标是"正常卡不触发截断，超长卡优先丢末尾而不是整块消失"。
 * 以后按实测调整，直接改这张表即可；`state` 刻意不设独立预算（变量数量由卡决定，走全局预算兜底）。
 */

import type { BlockSource } from '../../../../plugins/context-blocks/src/index.ts';
import type { PromptBlockDataV2 } from './prompt-blocks-v2.ts';

/** 每块默认 token 预算：character 800 / lore 500 / memory 400 / summary 300 / setup 300 / scene 200 / items 200 / examples 300 / rules 300 / custom 400。 */
export const BLOCK_TOKEN_BUDGETS: Readonly<Record<string, number>> = {
  'app.character': 800,
  'app.lore.matched': 500,
  'app.memory.matched': 400,
  'app.summary.matched': 300,
  'app.setup': 300,
  'app.scene': 200,
  'app.items': 200,
  'app.examples': 300,
  'app.rules': 300,
  'app.system.custom': 400,
};

/** 兜底路径逐角色拆块（`app.character.<id>`）：沿用 character 的预算。 */
const CHARACTER_PREFIX = 'app.character.';

/** 必须保留的块：全局预算不足时不裁（没有它们这次请求不可用）。 */
const MUST_KEEP = new Set(['app.character', 'app.setup']);

export function blockBudgetOf(id: string): number | undefined {
  if (id.startsWith(CHARACTER_PREFIX)) return BLOCK_TOKEN_BUDGETS['app.character'];
  return BLOCK_TOKEN_BUDGETS[id];
}

export function isMustKeepBlock(id: string): boolean {
  return MUST_KEEP.has(id) || id.startsWith(CHARACTER_PREFIX);
}

/** 注册块时展开成 `BlockDefinition` 的字段（缺省项不出现，便于测试做 deepEqual）。 */
export function blockMetaOf(id: string): { tokenBudget?: number; mustKeep?: boolean } {
  const tokenBudget = blockBudgetOf(id);
  return {
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(isMustKeepBlock(id) ? { mustKeep: true } : {}),
  };
}

// ---------------------------------------------------------------- 来源（B21）

function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

function joined(values: readonly string[]): string | undefined {
  const list = values.map((value) => value.trim()).filter((value) => value !== '');
  return list.length === 0 ? undefined : list.join(',');
}

function labeled(values: readonly string[]): string | undefined {
  const list = values.map((value) => value.trim()).filter((value) => value !== '');
  return list.length === 0 ? undefined : list.join('、');
}

function source(type: BlockSource['type'], ids: readonly string[], labels: readonly string[]): BlockSource {
  const id = joined(ids);
  const label = labeled(labels);
  return { type, ...(id === undefined ? {} : { id }), ...(label === undefined ? {} : { label }) };
}

function memberSource(data: PromptBlockDataV2): BlockSource {
  return source(
    'character',
    data.world.members.map((character) => character.meta.id),
    data.world.members.map((character) => trimmed(character.identity.name) || trimmed(character.meta.name)),
  );
}

function itemSource(data: PromptBlockDataV2): BlockSource {
  const members = new Set(data.world.members.map((character) => character.meta.id));
  const held = Object.keys(data.runtime.items)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => data.runtime.items[key])
    .filter((instance): instance is NonNullable<typeof instance> => instance !== undefined && members.has(instance.holder));
  return source(
    'item',
    held.map((instance) => instance.item_id),
    held.map((instance) => trimmed(data.world.itemById.get(instance.item_id)?.meta.name) || instance.item_id),
  );
}

/** 某个 position 的命中条目（`undefined` = 未设 position 的旧块）；id 与标签都来自本次实际命中的条目。 */
function loreSource(data: PromptBlockDataV2, position: number | undefined): BlockSource {
  const byId = new Map(data.world.loreCards.map((card) => [card.meta.id, card]));
  const entries = data.outcomes.matchedLore.filter((entry) => byId.get(entry.entryId)?.trigger?.position === position);
  return source('lore', entries.map((entry) => entry.entryId), entries.map((entry) => entry.bookName));
}

/**
 * 块的实体级来源。
 *
 * - character / rules / examples / state → 成员角色（`state` 无成员时退化为 session）；
 * - scene → 当前场景卡；items → 成员持有的物品实例；
 * - lore / memory / summary → 本次实际命中的条目 id；
 * - custom / setup → session（PLAN 要求的"设置来源"暂未使用）。
 * 聚合块 id 用逗号连接、label 用顿号连接（稳定顺序：成员顺序 / 实例 key 排序 / 命中顺序）。
 */
export function sourceOfBlock(id: string, data: PromptBlockDataV2): BlockSource | undefined {
  if (id.startsWith(CHARACTER_PREFIX)) {
    const characterId = id.slice(CHARACTER_PREFIX.length);
    const character = data.world.characterById.get(characterId);
    return source('character', [characterId], [trimmed(character?.identity.name) || trimmed(character?.meta.name)]);
  }
  if (id === 'app.character' || id === 'app.rules' || id === 'app.examples') return memberSource(data);
  if (id === 'app.state') return data.world.members.length > 0 ? memberSource(data) : source('session', [], [data.sessionTitle ?? '']);
  if (id === 'app.scene') {
    const sceneId = data.runtime.current_scene_id;
    if (sceneId === undefined) return undefined;
    const scene = data.world.sceneById.get(sceneId);
    return source('scene', [sceneId], [trimmed(scene?.meta.name)]);
  }
  if (id === 'app.items') return itemSource(data);
  if (id === 'app.lore.matched') return loreSource(data, undefined);
  if (id.startsWith('app.lore.pos')) {
    const position = Number.parseInt(id.slice('app.lore.pos'.length), 10);
    return loreSource(data, Number.isInteger(position) ? position : undefined);
  }
  if (id === 'app.memory.matched') {
    return source('memory', data.outcomes.matchedMemories.map((item) => item.memory.id), []);
  }
  if (id === 'app.summary.matched') {
    return source('summary', data.outcomes.matchedSummaries.map((item) => item.id), []);
  }
  if (id === 'app.setup' || id === 'app.system.custom') {
    return source('session', [], [data.sessionTitle ?? '']);
  }
  return undefined;
}
