/**
 * 典籍（lore）的检索块：把典籍卡送进 `packages/lore` 的关键词扫描器，并做三层过滤：
 *
 *  1. **条目级启停**（`LoreCard.enabled === false`）——作者语义，跟着卡片走；
 *  2. **条件**（`trigger.conditions`，变量表达式）——用 `packages/cards/expr` 求值，
 *     求值失败/不成立都不注入，并计入 `loreDropped`（面板如实显示"没进去几条"）；
 *  3. **概率**（`trigger.probability`）——确定性哈希，两台设备同一条消息结果一致。
 *
 * 从 `prompt-v2.ts` 抽出来是因为它继续变长会撞 400 行门禁；逻辑本身是纯函数。
 */

import { scanLore, type ScanBook, type ScoredEntry } from '../../../../packages/lore/src/index.ts';
import { evaluateConditions, flattenScope, type ExprScope } from '../../../../packages/cards/src/index.ts';
import type { LoreCard, SessionRuntime } from '../../../../packages/cards/src/index.ts';
import type { PromptBlockDataV2 } from './prompt-blocks-v2.ts';

/** FNV-1a：跨设备一致的整数哈希（不依赖平台/时间）。 */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 概率判定：未设 / ≥100 全注入；否则 hash(entryId|最后一条消息) % 100 < probability。 */
export function passesProbability(entryId: string, probability: number | undefined, lastMessageKey: string): boolean {
  if (probability === undefined || !Number.isFinite(probability) || probability >= 100) return true;
  return stableHash(`${entryId}|${lastMessageKey}`) % 100 < Math.max(0, probability);
}

/** 典籍卡 → 扫描书（每卡一条；priority 高 → order 小 → 先占预算）。 */
export function loreBooksOf(cards: readonly LoreCard[]): ScanBook[] {
  return cards.map((card) => ({
    id: card.meta.id,
    name: card.meta.name,
    enabled: true,
    entries: [
      {
        id: card.meta.id,
        keys: card.keys,
        secondaryKeys: card.secondary_keys ?? [],
        content: card.content,
        enabled: true,
        order: 100 - (card.trigger?.priority ?? 5),
        caseSensitive: false,
        recursive: card.trigger?.recursive ?? true,
        depth: card.trigger?.depth ?? 0,
        constant: card.trigger?.constant ?? false,
      },
    ],
  }));
}

/** 条件求值的作用域：会话变量打底，成员角色的变量覆盖同名项。 */
export function scopeOf(runtime: SessionRuntime, characterIds: readonly string[]): ExprScope {
  const scope: Record<string, ExprScope[string]> = { ...(runtime.variables['session'] ?? {}) };
  for (const characterId of characterIds) {
    for (const [name, value] of Object.entries(runtime.variables[`character:${characterId}`] ?? {})) {
      scope[name] = value;
    }
  }
  return scope;
}

/** 一条典籍的触发条件是否成立（空条件恒成立；求值失败 = 不成立）。 */
export function loreConditionsOk(card: LoreCard, scope: ExprScope): boolean {
  return evaluateConditions(card.trigger?.conditions ?? [], scope).ok;
}

/** 可参与扫描的典籍：先按条目级启停过滤，再按条件过滤（被条件拦下的计入 dropped）。 */
export function eligibleLoreCards(
  cards: readonly LoreCard[],
  runtime: SessionRuntime,
  characterIds: readonly string[],
): { cards: LoreCard[]; dropped: number } {
  const scope = flattenScope(runtime.variables, characterIds);
  const kept: LoreCard[] = [];
  let dropped = 0;
  for (const card of cards) {
    // 过渡兼容：早期迁移把"旧条目关闭"写成 meta.tags=['legacy-disabled']（那时还没有 enabled 字段）
    if (card.enabled === false || (card.meta.tags ?? []).includes('legacy-disabled')) {
      dropped += 1;
      continue;
    }
    if (!loreConditionsOk(card, scope)) {
      dropped += 1;
      continue;
    }
    kept.push(card);
  }
  return { cards: kept, dropped };
}

/** 渲染【相关设定】块；顺带把命中/丢弃写回 `data.outcomes`（请求面板用）。 */
export function loreTextOf(data: PromptBlockDataV2): string | undefined {
  if (data.world.loreCards.length === 0) return undefined;
  const eligible = eligibleLoreCards(data.world.loreCards, data.runtime, data.setup.characters);
  if (eligible.cards.length === 0) {
    data.outcomes.loreDropped = eligible.dropped;
    return undefined;
  }
  const result = scanLore({
    books: loreBooksOf(eligible.cards),
    messages: data.history.map((item) => ({ role: item.role, content: item.content })),
    ...(data.loreBudgetChars === undefined ? {} : { budgetChars: data.loreBudgetChars }),
  });
  const byId = new Map(eligible.cards.map((card) => [card.meta.id, card]));
  const kept: ScoredEntry[] = [];
  // trace 的 loreDropped = 条目停用/条件不满足 + 概率未命中 + 预算挤掉
  let dropped = eligible.dropped + result.dropped.length;
  for (const entry of result.matched) {
    const trigger = byId.get(entry.entryId)?.trigger;
    if (trigger?.constant === true || passesProbability(entry.entryId, trigger?.probability, data.lastMessageKey)) {
      kept.push(entry);
    } else {
      dropped += 1;
    }
  }
  data.outcomes.matchedLore = kept;
  data.outcomes.loreDropped = dropped;
  return kept.length === 0 ? undefined : `【相关设定】\n${kept.map((entry) => entry.content.trim()).join('\n')}`;
}
