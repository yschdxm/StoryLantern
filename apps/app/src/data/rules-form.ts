/**
 * 角色规则（`rules`）与物品行为（`behaviors`）的**纯表单逻辑**。
 *
 * 规则是结构化数据（不是一整段文本）：id / enabled / priority / when.event /
 * when.conditions / actions。编辑器草稿把条件、动作里的文本拆成输入框，
 * 保存时再拼回 `CardRule`；表单不编辑的字段通过 `raw` 原样保留。
 *
 * 条件表达式由 `packages/cards/src/expr.ts` 求值；这里只做**语法检查**：
 * 用「所有标识符都存在的代理 scope」跑一遍解析器，这样不会因为"变量运行时才有值"
 * 误报语法错误。
 */

import {
  evaluateExpression,
  tokenize,
  type CardRule,
  type ExprValue,
  type RuleAction,
  type RuleActionType,
  type RuleEvent,
} from '../../../../packages/cards/src/index.ts';
import { ulid } from '../../../../packages/oplog/src/index.ts';

export const RULE_EVENTS: readonly RuleEvent[] = ['before_prompt', 'before_reply', 'after_reply', 'on_state_change'];
export const RULE_ACTION_TYPES: readonly RuleActionType[] = ['constraint', 'inject_prompt', 'set_state', 'block'];

export interface RuleActionDraft {
  type: RuleActionType;
  text: string;
  stateName: string;
  stateExpr: string;
  /** 原动作：保留未知字段。 */
  raw?: RuleAction;
}

export interface RuleDraft {
  id: string;
  enabled: boolean;
  /** 文本输入框里的优先级；保存时解析为整数（非法回落 100）。 */
  priority: string;
  event: RuleEvent;
  /** 一行一条 → when.conditions；空行保存时丢弃。 */
  conditions: string;
  actions: RuleActionDraft[];
  /** 原规则：保留未知字段。 */
  raw?: CardRule;
}

export function emptyActionDraft(type: RuleActionType = 'constraint'): RuleActionDraft {
  return { type, text: '', stateName: '', stateExpr: '' };
}

export function emptyRuleDraft(): RuleDraft {
  return {
    id: ulid(),
    enabled: true,
    priority: '100',
    event: 'before_prompt',
    conditions: '',
    actions: [emptyActionDraft()],
  };
}

/** 条件文本 → 数组：按行拆分、去空白、丢空行（保持书写顺序）。 */
export function splitConditions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function conditionsText(conditions: readonly string[] | undefined): string {
  return (conditions ?? []).join('\n');
}

function actionEmpty(action: RuleActionDraft): boolean {
  return action.text.trim() === '' && action.stateName.trim() === '' && action.stateExpr.trim() === '';
}

/** 卡片 → 草稿：顺序保持；条件按行展开；动作里的未知字段挂 raw。 */
export function rulesToDrafts(rules: readonly CardRule[] | undefined): RuleDraft[] {
  return (rules ?? []).map((rule) => ({
    id: rule.id,
    enabled: rule.enabled !== false,
    priority: String(rule.priority ?? 100),
    event: rule.when.event,
    conditions: conditionsText(rule.when.conditions),
    actions: (rule.actions ?? []).map((action) => ({
      type: action.type,
      text: action.text ?? '',
      stateName: action.state_name ?? '',
      stateExpr: action.state_expr ?? '',
      raw: action,
    })),
    raw: rule,
  }));
}

function priorityOf(draft: RuleDraft): number {
  const value = Number(draft.priority.trim());
  return Number.isFinite(value) ? Math.round(value) : 100;
}

function buildAction(draft: RuleActionDraft): RuleAction {
  const next: Record<string, unknown> = { ...(draft.raw ?? {}) };
  next['type'] = draft.type;
  if (draft.type === 'set_state') {
    const stateName = draft.stateName.trim();
    const stateExpr = draft.stateExpr.trim();
    if (stateName === '') delete next['state_name'];
    else next['state_name'] = stateName;
    if (stateExpr === '') delete next['state_expr'];
    else next['state_expr'] = stateExpr;
    // set_state 不使用 text；用户从别的类型切过来时清掉旧值，避免两个真相
    delete next['text'];
  } else {
    const text = draft.text.trim();
    if (text === '') delete next['text'];
    else next['text'] = text;
    delete next['state_name'];
    delete next['state_expr'];
  }
  return next as unknown as RuleAction;
}

/**
 * 草稿 → 卡片：空动作丢弃；没有任何动作的规则整条丢弃（否则永远不生效）。
 * 条件按行拆分去空；`when.conditions` 为空时不写该字段。
 */
export function draftsToRules(drafts: readonly RuleDraft[]): CardRule[] {
  const rules: CardRule[] = [];
  for (const draft of drafts) {
    const actions = draft.actions.filter((action) => !actionEmpty(action)).map(buildAction);
    if (actions.length === 0) continue;
    const conditions = splitConditions(draft.conditions);
    const next: Record<string, unknown> = { ...(draft.raw ?? {}) };
    next['id'] = draft.id;
    next['enabled'] = draft.enabled;
    next['priority'] = priorityOf(draft);
    next['when'] = {
      ...(draft.raw?.when ?? {}),
      event: draft.event,
      ...(conditions.length === 0 ? {} : { conditions }),
    };
    next['actions'] = actions;
    rules.push(next as unknown as CardRule);
  }
  return rules;
}

/** 把规则挂回卡片；全部删除时移除 `rules` 字段（不写空数组）。 */
export function attachRules<T extends { rules?: readonly CardRule[] }>(card: T, rules: readonly CardRule[]): T {
  if (rules.length === 0) {
    const next = { ...card } as Record<string, unknown>;
    delete next['rules'];
    return next as T;
  }
  return { ...card, rules };
}

// ---------------------------------------------------------------- 语法检查

/** 让解析器把任何标识符都当成已知值：只暴露语法错误，不误报"未知变量"。 */
const SYNTAX_SCOPE: Readonly<Record<string, ExprValue>> = new Proxy({} as Record<string, ExprValue>, {
  has: () => true,
  get: () => 0,
  getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true, value: 0, writable: false }),
});

const SYNTAX_ERROR_HINTS = ['字符串没有闭合', '无法识别的字符', '表达式在', '括号没有闭合', '意外的运算符', '表达式不完整'];

export interface SyntaxCheck {
  ok: boolean;
  /** 确定的语法错误（用户必须改）。 */
  error?: string;
  /** 解析通过、但类型/运算要在运行时才知道（不是语法错误）。 */
  note?: string;
}

/** 检查一条条件表达式的语法；`unknown variable` 与类型问题不算语法错误。 */
export function checkConditionSyntax(source: string): SyntaxCheck {
  const text = source.trim();
  if (text === '') return { ok: false, error: 'empty' };
  try {
    tokenize(text);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
  const result = evaluateExpression(text, SYNTAX_SCOPE);
  if (result.error === undefined) return { ok: true };
  const syntax = SYNTAX_ERROR_HINTS.some((hint) => result.error?.includes(hint));
  return syntax ? { ok: false, error: result.error } : { ok: true, note: result.error };
}
