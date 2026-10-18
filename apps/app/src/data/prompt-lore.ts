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
import { applyRegexScripts, type RegexSkipped } from './regex-scripts.ts';
import { regexScriptsOfWorld } from './chat-regex.ts';
import { expandMacros } from './macros.ts';
import type { PromptBlockDataV2 } from './prompt-blocks-v2.ts';
import { SETTING_KEYS } from './types.ts';

// B13：world_info 正则统计挂在装配 data 上（trace 的数据源；prompt-v2 只负责把它抄进 trace）
declare module './prompt-blocks-v2.ts' {
  interface PromptOutcomesV2 {
    loreRegex?: { applied: number; skipped: RegexSkipped[] };
  }
}

/** 设置键：世界书扫描深度（与设置页/`SETTING_KEYS` 同一个键，避免两处字符串漂移）。 */
export const LORE_SCAN_DEPTH_SETTING = SETTING_KEYS.loreScanDepth;
export const DEFAULT_LORE_SCAN_DEPTH = 4;
const MAX_LORE_SCAN_DEPTH = 20;

/** 读设置：默认 4，允许 1–20；0/未设/非法值 = 用扫描器默认（4）。 */
export function loreScanDepthOf(settings: Record<string, string>): number | undefined {
  const depth = Number(settings[LORE_SCAN_DEPTH_SETTING]);
  return Number.isInteger(depth) && depth > 0 && depth <= MAX_LORE_SCAN_DEPTH ? depth : undefined;
}

/** FNV-1a：跨设备一致的整数哈希（不依赖平台/时间）。 */export function stableHash(text: string): number {
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
        matchWholeWords: card.trigger?.match_whole_words === true,
        // 扫描器只保留字段、不截断：单条预算由下面的 applyTokenBudget 在装配层执行。
        ...(card.trigger?.token_budget === undefined ? {} : { tokenBudget: card.trigger.token_budget }),
        recursive: card.trigger?.recursive ?? true,
        depth: card.trigger?.depth ?? 0,
        constant: card.trigger?.constant ?? false,
        ...(card.trigger?.selective_logic === undefined ? {} : { selectiveLogic: card.trigger.selective_logic }),
        ...(card.trigger?.exclude_recursion === true ? { excludeRecursion: true } : {}),
        ...(card.trigger?.prevent_recursion === true ? { preventRecursion: true } : {}),
        ...(card.trigger?.delay_until_recursion === undefined ? {} : { delayUntilRecursion: card.trigger.delay_until_recursion }),
        ...(card.trigger?.group === undefined || card.trigger.group.trim() === '' ? {} : { group: card.trigger.group }),
        ...(card.trigger?.group_weight === undefined ? {} : { groupWeight: card.trigger.group_weight }),
        ...(card.trigger?.sticky === undefined ? {} : { sticky: card.trigger.sticky }),
        ...(card.trigger?.cooldown === undefined ? {} : { cooldown: card.trigger.cooldown }),
        ...(card.trigger?.delay === undefined ? {} : { delay: card.trigger.delay }),
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

/**
 * 单条内容的字符预算：按 **Unicode 码点**截断，超出加 `…`。
 * 这是**装配层**行为（扫描器不截断、也不该伪称它做了）；`<=0` / 未设 = 不截断。
 */
export function applyTokenBudget(content: string, budget: number | undefined): string {
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return content;
  const points = Array.from(content);
  const limit = Math.floor(budget);
  return points.length <= limit ? content : `${points.slice(0, limit).join('')}…`;
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
    ...(data.loreScanDepth === undefined ? {} : { scanDepth: data.loreScanDepth }),
    ...(data.loreBudgetChars === undefined ? {} : { budgetChars: data.loreBudgetChars }),
  });
  const byId = new Map(eligible.cards.map((card) => [card.meta.id, card]));
  const kept: ScoredEntry[] = [];
  // B13：world_info 正则对每条命中内容执行；卡片原文不改（只改这次注入的副本）。
  const worldScripts = regexScriptsOfWorld(data.world);
  let regexApplied = 0;
  const regexSkipped: RegexSkipped[] = [];
  // trace 的 loreDropped = 条目停用/条件不满足 + 概率未命中 + 预算挤掉 + group/冷却/延迟抑制
  let dropped = eligible.dropped + result.dropped.length + result.suppressed;
  for (const entry of result.matched) {
    const trigger = byId.get(entry.entryId)?.trigger;
    if (trigger?.constant === true || passesProbability(entry.entryId, trigger?.probability, data.lastMessageKey)) {
      // 作者文本里的宏先展开，再跑 world_info 正则，最后按单条预算截断（模型看到的与 trace 记的同一份文本）。
      const expanded = expandMacros(entry.content, data.macros);
      const scripted = worldScripts.length === 0 ? { text: expanded, applied: 0, skipped: [] as RegexSkipped[] } : applyRegexScripts(expanded, 'world_info', worldScripts);
      regexApplied += scripted.applied;
      regexSkipped.push(...scripted.skipped);
      const injected = { ...entry, content: applyTokenBudget(scripted.text, trigger?.token_budget) };
      // 统计附着在注入副本上（不改进来的 ScoredEntry 类型）：调用方据此把 world_info 写进 trace/meta。
      if (scripted.applied > 0 || scripted.skipped.length > 0) {
        (injected as ScoredEntry & { worldInfoApplied?: number; worldInfoSkipped?: RegexSkipped[] }).worldInfoApplied = scripted.applied;
        (injected as ScoredEntry & { worldInfoApplied?: number; worldInfoSkipped?: RegexSkipped[] }).worldInfoSkipped = scripted.skipped;
      }
      kept.push(injected);
    } else {
      dropped += 1;
    }
  }
  data.outcomes.matchedLore = kept;
  data.outcomes.loreDropped = dropped;
  if (regexApplied > 0 || regexSkipped.length > 0) {
    data.outcomes.loreRegex = { applied: regexApplied, skipped: regexSkipped };
  }
  return kept.length === 0 ? undefined : `【相关设定】\n${kept.map((entry) => entry.content.trim()).join('\n')}`;
}
