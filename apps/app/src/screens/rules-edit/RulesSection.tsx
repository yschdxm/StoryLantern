import { useState, type ReactNode } from 'react';
import type { RuleActionType, RuleEvent } from '../../../../../packages/cards/src/index.ts';
import { useT } from '../../i18n/context.tsx';
import { Button, Field, TextArea, TextInput } from '../../ui/components.tsx';
import {
  RULE_ACTION_TYPES,
  RULE_EVENTS,
  checkConditionSyntax,
  emptyActionDraft,
  emptyRuleDraft,
  splitConditions,
  type RuleActionDraft,
  type RuleDraft,
} from '../../data/rules-form.ts';

/**
 * 规则/行为规则编辑（角色 `rules` 与物品 `behaviors` 共用）。
 *
 * 规则是结构化数据：id / 优先级 / 启用 / 事件 / when.conditions / actions。
 * 条件表达式由引擎在会话变量上求值；这里的「检查」只做**语法检查**，
 * 变量在运行时才有值，所以不会因为未知变量误报。
 */

interface CheckResult {
  ruleId: string;
  errors: string[];
  notes: string[];
}

export function RulesSection({
  rules,
  onChange,
  titleKey,
  events = RULE_EVENTS,
}: {
  rules: readonly RuleDraft[];
  onChange: (next: RuleDraft[]) => void;
  titleKey: string;
  events?: readonly RuleEvent[];
}): ReactNode {
  const t = useT();
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);
  const [check, setCheck] = useState<CheckResult | undefined>(undefined);

  const update = (id: string, patch: Partial<RuleDraft>): void => {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  };
  const updateAction = (ruleId: string, index: number, patch: Partial<RuleActionDraft>): void => {
    onChange(
      rules.map((rule) =>
        rule.id === ruleId
          ? { ...rule, actions: rule.actions.map((action, actionIndex) => (actionIndex === index ? { ...action, ...patch } : action)) }
          : rule,
      ),
    );
  };
  const add = (): void => {
    const rule = emptyRuleDraft();
    onChange([...rules, rule]);
    setExpandedId(rule.id);
  };
  const runCheck = (rule: RuleDraft): void => {
    const errors: string[] = [];
    const notes: string[] = [];
    for (const source of splitConditions(rule.conditions)) {
      const result = checkConditionSyntax(source);
      if (!result.ok) errors.push(`${source}：${result.error ?? ''}`);
      else if (result.note !== undefined) notes.push(`${source}：${result.note}`);
    }
    setCheck({ ruleId: rule.id, errors, notes });
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t(titleKey)}</h2>
      <p className="field__hint">{t('rules.hint')}</p>
      {rules.length === 0 && <p className="muted">{t('rules.empty')}</p>}
      {rules.map((rule) => {
        const open = expandedId === rule.id;
        const result = check?.ruleId === rule.id ? check : undefined;
        return (
          <div className="rule-row" key={rule.id}>
            <div className="rule-row__head">
              <button
                type="button"
                className="rule-row__main"
                aria-expanded={open}
                onClick={() => setExpandedId(open ? undefined : rule.id)}
              >
                <span className="rule-row__id">{rule.id}</span>
                <span className="rule-row__meta">
                  {t(`rules.event.${rule.event}`)}
                  {' · '}
                  {t('rules.priorityShort', { n: rule.priority })}
                  {' · '}
                  {rule.enabled ? t('rules.enabled') : t('rules.disabled')}
                </span>
              </button>
              <Button variant="ghost" onClick={() => onChange(rules.filter((item) => item.id !== rule.id))}>
                {t('rules.remove')}
              </Button>
            </div>

            <div className="rule-row__controls">
              <label className="switch">
                <input type="checkbox" checked={rule.enabled} onChange={(event) => update(rule.id, { enabled: event.target.checked })} />
                <span>{t('rules.enabled')}</span>
              </label>
              <Field label={t('rules.event')}>
                <select
                  className="input"
                  value={rule.event}
                  aria-label={t('rules.event')}
                  onChange={(event) => update(rule.id, { event: event.target.value as RuleEvent })}
                >
                  {events.map((event) => (
                    <option key={event} value={event}>
                      {t(`rules.event.${event}`)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('rules.priority')}>
                <TextInput type="number" value={rule.priority} onChange={(value) => update(rule.id, { priority: value })} />
              </Field>
            </div>

            {open && (
              <div className="rule-row__body">
                <Field label={t('rules.conditions')} hint={t('rules.conditions.hint')}>
                  <TextArea
                    value={rule.conditions}
                    onChange={(value) => update(rule.id, { conditions: value })}
                    rows={3}
                    placeholder={t('rules.conditions.placeholder')}
                  />
                </Field>
                <Button variant="ghost" onClick={() => runCheck(rule)}>
                  {t('rules.check')}
                </Button>
                {result !== undefined && (
                  <div className="rule-check" role="status">
                    {result.errors.length > 0 ? (
                      result.errors.map((error, index) => (
                        <p className="notice notice--warn" key={`${rule.id}-error-${String(index)}`}>
                          {error}
                        </p>
                      ))
                    ) : (
                      <p className="notice notice--ok">{t('rules.check.ok')}</p>
                    )}
                    {result.notes.length > 0 && <p className="field__hint">{t('rules.check.runtime')}</p>}
                  </div>
                )}

                <h3 className="settings-group__title">{t('rules.actions')}</h3>
                {rule.actions.map((action, index) => (
                  <div className="rule-action" key={`${rule.id}-action-${String(index)}`}>
                    <div className="rule-row__head">
                      <select
                        className="input"
                        value={action.type}
                        aria-label={t('rules.action.type')}
                        onChange={(event) => updateAction(rule.id, index, { type: event.target.value as RuleActionType })}
                      >
                        {RULE_ACTION_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {t(`rules.action.${type}`)}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="ghost"
                        onClick={() => update(rule.id, { actions: rule.actions.filter((_, actionIndex) => actionIndex !== index) })}
                      >
                        {t('rules.removeAction')}
                      </Button>
                    </div>
                    {action.type === 'set_state' ? (
                      <>
                        <Field label={t('rules.action.stateName')}>
                          <TextInput value={action.stateName} onChange={(value) => updateAction(rule.id, index, { stateName: value })} />
                        </Field>
                        <Field label={t('rules.action.stateExpr')} hint={t('rules.action.stateExpr.hint')}>
                          <TextInput value={action.stateExpr} onChange={(value) => updateAction(rule.id, index, { stateExpr: value })} />
                        </Field>
                      </>
                    ) : (
                      <Field label={t('rules.action.text')} hint={t('rules.action.text.hint')}>
                        <TextArea
                          value={action.text}
                          onChange={(value) => updateAction(rule.id, index, { text: value })}
                          rows={2}
                          placeholder={t('rules.action.text.placeholder')}
                        />
                      </Field>
                    )}
                  </div>
                ))}
                <Button
                  variant="ghost"
                  onClick={() => update(rule.id, { actions: [...rule.actions, emptyActionDraft()] })}
                >
                  {t('rules.addAction')}
                </Button>
              </div>
            )}
          </div>
        );
      })}
      <Button variant="ghost" onClick={add}>
        {t('rules.add')}
      </Button>
    </section>
  );
}
