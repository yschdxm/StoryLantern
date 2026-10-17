/**
 * 角色规则块（`app.rules`）：只取**这个事件**（`before_prompt`）下要注入的文本。
 *
 * 条件求值走 `packages/cards/expr`：
 *  - 条件成立 → 注入；
 *  - 条件不成立 → 跳过；
 *  - 条件求值失败（未知变量/类型不匹配）→ 跳过并计数（`rulesOmitted`），
 *    **不假装它生效**，也不猜作者想表达什么。
 *
 * 抽成独立文件是为了让 `prompt-blocks-v2.ts` 留在 400 行门禁内。
 */

import { evaluateConditions, type ExprScope } from '../../../../packages/cards/src/index.ts';
import type { CardRule, StateValue } from '../../../../packages/cards/src/index.ts';
import type { PromptBlockDataV2 } from './prompt-blocks-v2.ts';

/** 角色规则的条件作用域：会话变量打底，该角色的变量覆盖同名项。 */
function ruleScope(data: PromptBlockDataV2, characterId: string): ExprScope {
  const scope: Record<string, StateValue | undefined> = { ...(data.runtime.variables['session'] ?? {}) };
  for (const [name, value] of Object.entries(data.runtime.variables[`character:${characterId}`] ?? {})) {
    scope[name] = value;
  }
  return scope;
}

/** 一条规则要注入的文本（只认 constraint / inject_prompt；没文本就不算）。 */
function textsOf(rule: CardRule): string[] {
  return rule.actions
    .filter((action) => action.type === 'constraint' || action.type === 'inject_prompt')
    .map((action) => (action.text ?? '').trim())
    .filter((text) => text !== '');
}

export function renderRulesSection(data: PromptBlockDataV2): string | undefined {
  const rules: Array<{ priority: number; owner: string; id: string; text: string }> = [];
  let omitted = 0;

  for (const character of data.world.members) {
    for (const rule of character.rules ?? []) {
      if (!rule.enabled) continue;
      if (rule.when.event !== 'before_prompt') continue;
      const texts = textsOf(rule);
      if (texts.length === 0) continue;

      const conditions = rule.when.conditions ?? [];
      if (conditions.length > 0) {
        const verdict = evaluateConditions(conditions, ruleScope(data, character.meta.id));
        if (!verdict.ok) {
          omitted += 1;
          continue;
        }
      }
      rules.push({ priority: rule.priority, owner: character.meta.id, id: rule.id, text: texts.join('\n') });
    }
  }

  data.outcomes.rulesOmitted = omitted;
  rules.sort((a, b) => b.priority - a.priority || a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id));
  return rules.length === 0 ? undefined : rules.map((rule) => rule.text).join('\n');
}
