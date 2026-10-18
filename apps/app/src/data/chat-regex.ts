import { applyRegexScripts, regexScriptsOfExtensions, type RegexScript, type RegexSkipped } from './regex-scripts.ts';
import type { CardDocument, SessionSetup } from '../../../../packages/cards/src/index.ts';
import type { PromptBlockDataV2, PromptWorldV2 } from './prompt-blocks-v2.ts';
import type { MessageRegexStat } from './types.ts';

/**
 * B13：把正则脚本接进聊天链路的四个 placement。
 *
 * 数据只在这里转换，页面不写脚本逻辑；卡片原文永不修改（都是 `string → string` 的纯函数）。
 * 脚本来源统一是**当前会话激活卡片**的 `extensions.storylantern.regex_scripts`。
 */

export interface RegexTransform {
  text: string;
  applied: number;
  skipped: RegexSkipped[];
}

/** 从一组卡片取脚本；`setup.overrides[id] === false` 的卡片不参与（workspace.cards 通常已过滤）。 */
export function regexScriptsOfCards(
  cards: readonly CardDocument[],
  setup: SessionSetup | undefined,
): RegexScript[] {
  return cards
    .filter((card) => setup?.overrides?.[card.meta.id] !== false)
    .flatMap((card) => regexScriptsOfExtensions(card.extensions));
}

/** 世界书装配路径拿脚本：`PromptWorldV2` 里已按激活规则分好类的卡片。 */
export function regexScriptsOfWorld(world: PromptWorldV2): RegexScript[] {
  return [
    ...world.members,
    ...[...world.sceneById.values()],
    ...[...world.itemById.values()],
    ...world.loreCards,
  ].flatMap((card) => regexScriptsOfExtensions(card.extensions));
}

/** 一次 placement 的转换（通用）。 */
export function transformRegex(
  text: string,
  placement: 'user_input' | 'ai_output' | 'world_info' | 'reasoning',
  scripts: readonly RegexScript[],
): RegexTransform {
  const result = applyRegexScripts(text, placement, scripts);
  return { text: result.text, applied: result.applied, skipped: result.skipped };
}

/** 用户输入：只转换本次输入（历史与库里的原文不动）。 */
export function transformUserInput(
  text: string,
  cards: readonly CardDocument[],
  setup: SessionSetup | undefined,
): RegexTransform {
  return transformRegex(text, 'user_input', regexScriptsOfCards(cards, setup));
}

/** 模型正文：在引用标记 strip **之前**执行（否则用户脚本会把 `[1]` 当正文改掉）。 */
export function transformAiOutput(
  text: string,
  cards: readonly CardDocument[],
  setup: SessionSetup | undefined,
): RegexTransform {
  return transformRegex(text, 'ai_output', regexScriptsOfCards(cards, setup));
}

/** 思考链：落 meta / 展示前转换。 */
export function transformReasoning(
  text: string,
  cards: readonly CardDocument[],
  setup: SessionSetup | undefined,
): RegexTransform {
  return transformRegex(text, 'reasoning', regexScriptsOfCards(cards, setup));
}

/** 只把有执行/跳过的统计变成 meta 条目（没有脚本时不写噪音）。 */
export function regexStatOf(
  placement: MessageRegexStat['placement'],
  transform: RegexTransform,
): MessageRegexStat | undefined {
  if (transform.applied === 0 && transform.skipped.length === 0) return undefined;
  return { placement, applied: transform.applied, skipped: transform.skipped };
}

/** 便捷：一次收集多条统计，过滤掉空项。 */
export function regexStatsOf(stats: readonly (MessageRegexStat | undefined)[]): MessageRegexStat[] {
  return stats.filter((stat): stat is MessageRegexStat => stat !== undefined);
}

/** 装配层（prompt-lore）用：world_info 脚本对所有激活卡片取。 */
export function applyWorldInfoToData(data: PromptBlockDataV2, content: string): RegexTransform {
  return transformRegex(content, 'world_info', regexScriptsOfWorld(data.world));
}
