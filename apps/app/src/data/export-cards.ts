/**
 * 卡片模型 → 酒馆（SillyTavern）格式的**纯导出映射**（§15.5）。
 *
 * 原则只有一条：**只导出能映射的字段**。卡片里有、酒馆没有的字段（state / rules / visuals /
 * 防幻觉边界…）如实列进 `losses`，由界面提示"导出后会丢失"，不假装无损。
 *
 * 卡片没有 scenario / 开场白（它们属于会话层）：导出时从 `CompatStashEntry` 草稿读回，
 * 没有草稿就写空串——这与导入方向是同一个约定。
 */

import type { CharacterCard, CompatStashEntry, LoreCard, WorldPackManifest } from '../../../../packages/cards/src/index.ts';

export interface ExportPlan {
  json: string;
  losses: string[];
}

/** 与导入/迁移/兼容视图同一个分隔符：首段是主开场白，其余是备选。 */
const OPENING_SEPARATOR = '\n\n---\n\n';

/** 草稿按时间取最新（同时间用 id 破平局，保证确定性）。 */
function latestStashText(stash: readonly CompatStashEntry[], characterId: string, kind: CompatStashEntry['kind']): string | undefined {
  const entries = stash
    .filter((entry) => entry.character_id === characterId && entry.kind === kind)
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  return entries[entries.length - 1]?.text;
}

function splitOpening(text: string | undefined): { first: string; alternates: string[] } {
  if (text === undefined || text.trim() === '') return { first: '', alternates: [] };
  const parts = text.split(OPENING_SEPARATOR).map((part) => part.trim());
  return { first: parts[0] ?? '', alternates: parts.slice(1).filter((part) => part !== '') };
}

/** `examples[]` → 酒馆 `mes_example`：`{{user}}:` / `{{char}}:` 前缀，组之间空行分隔。 */
function examplesText(card: CharacterCard): string {
  return (card.examples ?? [])
    .map((group) =>
      group.messages.map((message) => `${message.role === 'user' ? '{{user}}' : '{{char}}'}: ${message.content}`).join('\n'),
    )
    .filter((text) => text !== '')
    .join('\n\n');
}

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}

function listLosses(items: readonly unknown[], field: string): string[] {
  return items.length === 0 ? [] : [field];
}

/** 我们的字段里，酒馆 v2 没有对应的：挑重要的报，避免把提示淹没在噪音里。 */
function characterLosses(card: CharacterCard): string[] {
  const losses: string[] = [];
  if (hasText(card.persona.knowledge_boundary)) losses.push('persona.knowledge_boundary');
  if (hasText(card.persona.ability_boundary)) losses.push('persona.ability_boundary');
  if (hasText(card.persona.default_mood)) losses.push('persona.default_mood');
  losses.push(...listLosses(card.persona.values ?? [], 'persona.values'));
  losses.push(...listLosses(card.persona.goals ?? [], 'persona.goals'));
  losses.push(...listLosses(card.persona.fears ?? [], 'persona.fears'));
  losses.push(...listLosses(card.persona.taboos ?? [], 'persona.taboos'));
  losses.push(...listLosses(card.persona.metamorphosis ?? [], 'persona.metamorphosis'));
  if (hasText(card.speech.style)) losses.push('speech.style');
  if (hasText(card.speech.tone)) losses.push('speech.tone');
  losses.push(...listLosses(card.speech.vocabulary ?? [], 'speech.vocabulary'));
  losses.push(...listLosses(card.speech.forbidden_words ?? [], 'speech.forbidden_words'));
  losses.push(...listLosses(card.speech.example_lines ?? [], 'speech.example_lines'));
  if (hasText(card.speech.narration_style)) losses.push('speech.narration_style');
  if (card.state !== undefined) losses.push('state');
  losses.push(...listLosses(card.rules ?? [], 'rules'));
  losses.push(...listLosses(card.visuals ?? [], 'visuals'));
  if (card.appearance !== undefined && Object.keys(card.appearance).length > 0) losses.push('appearance');
  if (hasText(card.brief)) losses.push('brief');
  losses.push(...listLosses(card.refs ?? [], 'refs'));
  if (card.presentation !== undefined) losses.push('presentation');
  if (card.memory !== undefined) losses.push('memory');
  if (card.agent !== undefined) losses.push('agent');
  if (card.extensions !== undefined && Object.keys(card.extensions).length > 0) losses.push('extensions');
  if (card.examples?.some((group) => group.tags !== undefined || group.context !== undefined) === true) {
    losses.push('examples[].tags/context');
  }
  if (card.meta.rating !== 'general') losses.push('meta.rating');
  losses.push(...listLosses(card.meta.content_warnings ?? [], 'meta.content_warnings'));
  if (card.meta.language !== 'zh-CN') losses.push('meta.language');
  if (hasText(card.meta.cover)) losses.push('meta.cover');
  return losses;
}

/** 角色卡 → 酒馆 v2 JSON（`first_mes` / `alternate_greetings` / `scenario` 从草稿读回）。 */
export function exportCharacterCard(card: CharacterCard, stash: readonly CompatStashEntry[]): ExportPlan {
  const opening = splitOpening(latestStashText(stash, card.meta.id, 'opening'));
  const scenario = latestStashText(stash, card.meta.id, 'scenario') ?? '';
  const summary = card.persona.summary.trim();
  const traits = card.persona.traits.map((item) => item.trim()).filter((item) => item !== '');
  const data: Record<string, unknown> = {
    name: card.identity.name,
    description: card.identity.background,
    // 与兼容视图的拼法一致：第一行人设 + 性格标签
    personality: [summary, ...traits].filter((item) => item !== '').join('\n'),
    scenario,
    first_mes: opening.first,
    mes_example: examplesText(card),
    system_prompt: card.prompts?.system_extra ?? '',
    post_history_instructions: card.prompts?.post_history_instructions ?? '',
    creator_notes: card.meta.description,
    character_version: card.meta.version,
    ...(opening.alternates.length === 0 ? {} : { alternate_greetings: opening.alternates }),
    ...(card.meta.tags === undefined || card.meta.tags.length === 0 ? {} : { tags: [...card.meta.tags] }),
    ...(card.meta.author === undefined || card.meta.author === '' ? {} : { creator: card.meta.author }),
  };
  return {
    json: JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data }, null, 2),
    losses: characterLosses(card),
  };
}

/** 单条典籍卡 → 酒馆世界书条目（ST 原生字段名）。 */
function loreEntryJson(card: LoreCard, index: number): Record<string, unknown> {
  const trigger = card.trigger ?? {};
  const secondary = card.secondary_keys === undefined ? [] : [...card.secondary_keys];
  const logic = card.logic ?? 'any';
  return {
    uid: index,
    key: [...(card.keys ?? [])],
    keysecondary: secondary,
    comment: card.meta.name,
    content: card.content,
    constant: trigger.constant === true,
    // 条目级启停是卡片字段（作者语义），可以原样往返
    disable: card.enabled === false,
    order: trigger.priority ?? 100,
    depth: trigger.depth ?? 0,
    // excludeRecursion 是 ST 原生字段：显式值优先，否则沿用 recursive 的取反（旧语义）
    exclude_recursion: trigger.exclude_recursion ?? trigger.recursive === false,
    probability: trigger.probability ?? 100,
    // 整词匹配：ST 原生字段；没设就不写（false 与缺省语义相同，写出来只是噪音）
    ...(trigger.match_whole_words === undefined ? {} : { matchWholeWords: trigger.match_whole_words }),
    // B3–B6：ST 高级世界书字段反向写回（未设不写）
    ...(trigger.selective_logic === undefined ? {} : { selectiveLogic: trigger.selective_logic }),
    ...(trigger.prevent_recursion === undefined ? {} : { preventRecursion: trigger.prevent_recursion }),
    ...(trigger.delay_until_recursion === undefined
      ? {}
      : { delayUntilRecursion: trigger.delay_until_recursion }),
    ...(trigger.group === undefined ? {} : { group: trigger.group }),
    ...(trigger.group_weight === undefined ? {} : { groupWeight: trigger.group_weight }),
    ...(trigger.sticky === undefined ? {} : { sticky: trigger.sticky }),
    ...(trigger.cooldown === undefined ? {} : { cooldown: trigger.cooldown }),
    ...(trigger.delay === undefined ? {} : { delay: trigger.delay }),
    // 单条预算：ST 没有原生字段。写进扩展命名空间（导入时从同一位置读回），不当作 ST 原生字段。
    ...(trigger.token_budget === undefined
      ? {}
      : { extensions: { storylantern: { token_budget: trigger.token_budget } } }),
    ...(secondary.length === 0 && trigger.selective_logic === undefined
      ? {}
      : {
          selective: true,
          selectiveLogic: trigger.selective_logic ?? (logic === 'all' ? 0 : logic === 'not' ? 1 : 2),
        }),
  };
}

function lorebookLosses(pack: WorldPackManifest, cards: readonly LoreCard[]): string[] {
  const losses: string[] = [];
  const add = (field: string): void => {
    if (!losses.includes(field)) losses.push(field);
  };
  if (pack.author !== undefined) add('pack.author');
  if (pack.license !== undefined) add('pack.license');
  if (pack.language !== 'zh-CN') add('pack.language');
  if ((pack.tags?.length ?? 0) > 0) add('pack.tags');
  for (const card of cards) {
    if (hasText(card.summary)) add('lore.summary');
    if (card.kind !== 'other') add('lore.kind');
    if ((card.trigger?.probability ?? 100) !== 100) add('lore.trigger.probability');
    if ((card.trigger?.conditions?.length ?? 0) > 0) add('lore.trigger.conditions');
    // token_budget 已写进 extensions.storylantern（导入能读回），不再算丢失
    if ((card.refs?.length ?? 0) > 0) add('lore.refs');
    if ((card.visuals?.length ?? 0) > 0) add('lore.visuals');
    if (card.appearance !== undefined && Object.keys(card.appearance).length > 0) add('lore.appearance');
    if (hasText(card.brief)) add('lore.brief');
    if ((card.meta.tags?.length ?? 0) > 0) add('lore.meta.tags');
    // 酒馆条目只有数字 uid：我们的卡片 id 不会往返保留（再导入会生成新 id）
    add('lore.meta.id');
  }
  return losses;
}

/** 世界包 + 典籍卡 → 酒馆世界书 JSON（ST 原生 `entries` 是 uid→条目的 map）。 */
export function exportLorebook(pack: WorldPackManifest, cards: readonly LoreCard[]): ExportPlan {
  const entries: Record<string, unknown> = {};
  cards.forEach((card, index) => {
    entries[String(index)] = loreEntryJson(card, index);
  });
  return {
    json: JSON.stringify({ name: pack.name, description: pack.description ?? '', entries }, null, 2),
    losses: lorebookLosses(pack, cards),
  };
}
