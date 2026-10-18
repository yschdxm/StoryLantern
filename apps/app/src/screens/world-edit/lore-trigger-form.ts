/**
 * 典籍「触发策略」的纯表单逻辑（world-form.ts 已贴近 400 行，抽出来）。
 *
 * B3–B6 的字段语义来自 SillyTavern 世界书：次键逻辑 0–3、递归三选项、
 * 分组权重、sticky/cooldown/delay 轮次。空字符串 = 未设；0 是合法轮次/权重。
 * 未知字段通过 existing 的 spread 保留，受控字段在关闭/清空时删除。
 */

import type { LoreTrigger } from '../../../../../packages/cards/src/index.ts';

/** 触发策略草稿；空串 = 未设（数字/文本），selectiveLogic 默认 '0'。 */
export interface LoreTriggerDraft {
  constant: boolean;
  priority: string;
  probability: string;
  recursive: boolean;
  depth: string;
  conditions: string;
  matchWholeWords: boolean;
  tokenBudget: string;
  /** 次键逻辑：0=AND ANY、1=NOT ALL、2=NOT ANY、3=AND ALL。 */
  selectiveLogic: string;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  /** 递归延迟轮次；空 = 未设。 */
  delayUntilRecursion: string;
  /** 分组名；空 = 未分组。 */
  group: string;
  /** 组内权重 0–100；空 = 未设（按优先级）。 */
  groupWeight: string;
  /** 命中后保持轮次；空/0 = 不启用。 */
  sticky: string;
  /** 触发后冷却轮次；空 = 不启用。 */
  cooldown: string;
  /** 首次允许触发前的延迟轮次；空 = 不启用。 */
  delay: string;
}

export function emptyLoreTriggerDraft(): LoreTriggerDraft {
  return {
    constant: false,
    priority: '5',
    probability: '100',
    recursive: true,
    depth: '',
    conditions: '',
    matchWholeWords: false,
    tokenBudget: '',
    selectiveLogic: '0',
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: '',
    group: '',
    groupWeight: '',
    sticky: '',
    cooldown: '',
    delay: '',
  };
}

const numberText = (value: number | undefined): string => (value === undefined ? '' : String(value));

export function loreTriggerDraftOf(trigger: LoreTrigger | undefined): LoreTriggerDraft {
  return {
    constant: trigger?.constant === true,
    priority: trigger?.priority === undefined ? '5' : String(trigger.priority),
    probability: trigger?.probability === undefined ? '100' : String(trigger.probability),
    recursive: trigger?.recursive !== false,
    depth: numberText(trigger?.depth),
    conditions: (trigger?.conditions ?? []).join('\n'),
    matchWholeWords: trigger?.match_whole_words === true,
    tokenBudget: numberText(trigger?.token_budget),
    selectiveLogic: String(trigger?.selective_logic ?? 0),
    excludeRecursion: trigger?.exclude_recursion === true,
    preventRecursion: trigger?.prevent_recursion === true,
    delayUntilRecursion: numberText(trigger?.delay_until_recursion),
    group: trigger?.group ?? '',
    groupWeight: numberText(trigger?.group_weight),
    sticky: numberText(trigger?.sticky),
    cooldown: numberText(trigger?.cooldown),
    delay: numberText(trigger?.delay),
  };
}

function numberOf(text: string): number | undefined {
  const clean = text.trim();
  if (clean === '') return undefined;
  const value = Number(clean);
  return Number.isFinite(value) ? value : undefined;
}

function roundsOf(text: string): number | undefined {
  const value = numberOf(text);
  return value === undefined ? undefined : Math.max(0, Math.round(value));
}

function selectiveOf(text: string): 0 | 1 | 2 | 3 {
  const value = numberOf(text);
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  return 0;
}

/** 受控字段先删再按草稿写：关闭/清空必须真的从卡片上消失，不能被 spread 留住。 */
export function buildLoreTrigger(existing: LoreTrigger | undefined, draft: LoreTriggerDraft): LoreTrigger {
  const trigger: LoreTrigger = {
    ...existing,
    constant: draft.constant,
    priority: numberOf(draft.priority) ?? 5,
    probability: numberOf(draft.probability) ?? 100,
    recursive: draft.recursive,
    selective_logic: selectiveOf(draft.selectiveLogic),
  };
  for (const key of [
    'depth', 'conditions', 'match_whole_words', 'token_budget', 'exclude_recursion', 'prevent_recursion',
    'delay_until_recursion', 'group', 'group_weight', 'sticky', 'cooldown', 'delay',
  ] as const) {
    delete trigger[key];
  }
  const depth = numberOf(draft.depth);
  if (depth !== undefined) trigger.depth = Math.max(0, Math.round(depth));
  const conditions = draft.conditions.split(/\r?\n/).map((item) => item.trim()).filter((item) => item !== '');
  if (conditions.length > 0) trigger.conditions = conditions;
  if (draft.matchWholeWords) trigger.match_whole_words = true;
  const budget = numberOf(draft.tokenBudget);
  if (budget !== undefined) trigger.token_budget = Math.max(1, Math.round(budget));
  if (draft.excludeRecursion) trigger.exclude_recursion = true;
  if (draft.preventRecursion) trigger.prevent_recursion = true;
  const delayUntil = roundsOf(draft.delayUntilRecursion);
  if (delayUntil !== undefined) trigger.delay_until_recursion = delayUntil;
  const group = draft.group.trim();
  if (group !== '') trigger.group = group;
  const weight = numberOf(draft.groupWeight);
  if (weight !== undefined) trigger.group_weight = Math.min(100, Math.max(0, Math.round(weight)));
  const sticky = roundsOf(draft.sticky);
  if (sticky !== undefined) trigger.sticky = sticky;
  const cooldown = roundsOf(draft.cooldown);
  if (cooldown !== undefined) trigger.cooldown = cooldown;
  const delay = roundsOf(draft.delay);
  if (delay !== undefined) trigger.delay = delay;
  return trigger;
}
