import type { ReactNode } from 'react';
import type { LoreKind, LoreLogic } from '../../../../../packages/cards/src/index.ts';
import { useT } from '../../i18n/context.tsx';
import { Field, TextArea, TextInput } from '../../ui/components.tsx';
import type { LoreDraft } from './world-form.ts';

/**
 * 典籍（原世界书）分区：启停 / 分类 / 内容 / 概述 / 触发词 / 匹配逻辑 / 触发策略。
 *
 * 关键词触发是典籍**唯一**适合的激活方式（设计文档 6.5）；条件表达式由
 * `packages/cards/expr` 求值（不成立或求值失败都不注入，请求面板会如实计数）。
 */

const LORE_KINDS: readonly LoreKind[] = ['rule', 'history', 'faction', 'race', 'culture', 'geography', 'tech', 'other'];
const LORE_LOGIC: readonly LoreLogic[] = ['any', 'all', 'not'];

export function LoreSections({
  draft,
  update,
}: {
  draft: LoreDraft;
  update: (patch: Partial<LoreDraft>) => void;
}): ReactNode {
  const t = useT();
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('world.editor.lore.title')}</h2>
      <label className="switch">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        <span>{t('world.editor.lore.enabled')}</span>
      </label>
      <p className="muted">{t('world.editor.lore.enabled.hint')}</p>
      <Field label={t('world.editor.lore.kind')}>
        <select
          className="input"
          value={draft.loreKind}
          aria-label={t('world.editor.lore.kind')}
          onChange={(event) => update({ loreKind: event.target.value as LoreKind })}
        >
          {LORE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`world.lore.kind.${kind}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`${t('world.editor.lore.content')}*`} hint={t('world.editor.lore.content.hint')}>
        <TextArea
          value={draft.content}
          onChange={(value) => update({ content: value })}
          rows={5}
          placeholder={t('world.editor.lore.content.placeholder')}
        />
      </Field>
      <Field label={t('world.editor.lore.summary')} hint={t('world.editor.lore.summary.hint')}>
        <TextInput value={draft.summary} onChange={(value) => update({ summary: value })} />
      </Field>
      <Field label={`${t('world.editor.lore.keys')}*`} hint={t('world.editor.lore.keys.hint')}>
        <TextInput
          value={draft.keys}
          onChange={(value) => update({ keys: value })}
          placeholder={t('world.editor.lore.keys.placeholder')}
        />
      </Field>
      <Field label={t('world.editor.lore.secondaryKeys')} hint={t('world.editor.lore.secondaryKeys.hint')}>
        <TextInput value={draft.secondaryKeys} onChange={(value) => update({ secondaryKeys: value })} />
      </Field>
      <Field label={t('world.editor.lore.logic')}>
        <select
          className="input"
          value={draft.logic}
          aria-label={t('world.editor.lore.logic')}
          onChange={(event) => update({ logic: event.target.value as LoreLogic })}
        >
          {LORE_LOGIC.map((logic) => (
            <option key={logic} value={logic}>
              {t(`world.logic.${logic}`)}
            </option>
          ))}
        </select>
      </Field>

      <h3 className="settings-group__title">{t('world.editor.lore.trigger')}</h3>
      <label className="switch">
        <input
          type="checkbox"
          checked={draft.trigger.constant}
          onChange={(event) => update({ trigger: { ...draft.trigger, constant: event.target.checked } })}
        />
        <span>{t('world.editor.lore.trigger.constant')}</span>
      </label>
      <div className="world-pair">
        <Field label={t('world.editor.lore.trigger.priority')}>
          <TextInput
            type="number"
            value={draft.trigger.priority}
            onChange={(value) => update({ trigger: { ...draft.trigger, priority: value } })}
          />
        </Field>
        <Field label={t('world.editor.lore.trigger.probability')}>
          <TextInput
            type="number"
            value={draft.trigger.probability}
            onChange={(value) => update({ trigger: { ...draft.trigger, probability: value } })}
          />
        </Field>
      </div>
      <Field label={t('world.editor.lore.trigger.selectiveLogic')} hint={t('world.editor.lore.trigger.selectiveLogic.hint')}>
        <select
          className="input"
          value={draft.trigger.selectiveLogic}
          aria-label={t('world.editor.lore.trigger.selectiveLogic')}
          onChange={(event) => update({ trigger: { ...draft.trigger, selectiveLogic: event.target.value } })}
        >
          {['0', '1', '2', '3'].map((value) => (
            <option key={value} value={value}>
              {t(`world.editor.lore.trigger.selectiveLogic.${value}`)}
            </option>
          ))}
        </select>
      </Field>
      <label className="switch">
        <input
          type="checkbox"
          checked={draft.trigger.recursive}
          onChange={(event) => update({ trigger: { ...draft.trigger, recursive: event.target.checked } })}
        />
        <span>{t('world.editor.lore.trigger.recursive')}</span>
      </label>
      <label className="switch">
        <input
          type="checkbox"
          checked={draft.trigger.excludeRecursion}
          onChange={(event) => update({ trigger: { ...draft.trigger, excludeRecursion: event.target.checked } })}
        />
        <span>{t('world.editor.lore.trigger.excludeRecursion')}</span>
      </label>
      <p className="field__hint">{t('world.editor.lore.trigger.excludeRecursion.hint')}</p>
      <label className="switch">
        <input
          type="checkbox"
          checked={draft.trigger.preventRecursion}
          onChange={(event) => update({ trigger: { ...draft.trigger, preventRecursion: event.target.checked } })}
        />
        <span>{t('world.editor.lore.trigger.preventRecursion')}</span>
      </label>
      <p className="field__hint">{t('world.editor.lore.trigger.preventRecursion.hint')}</p>
      <Field
        label={t('world.editor.lore.trigger.delayUntilRecursion')}
        hint={t('world.editor.lore.trigger.delayUntilRecursion.hint')}
      >
        <TextInput
          type="number"
          value={draft.trigger.delayUntilRecursion}
          onChange={(value) => update({ trigger: { ...draft.trigger, delayUntilRecursion: value } })}
        />
      </Field>
      <label className="switch">
        <input
          type="checkbox"
          checked={draft.trigger.matchWholeWords}
          onChange={(event) => update({ trigger: { ...draft.trigger, matchWholeWords: event.target.checked } })}
        />
        <span>{t('world.editor.lore.trigger.matchWholeWords')}</span>
      </label>
      <p className="field__hint">{t('world.editor.lore.trigger.matchWholeWords.hint')}</p>
      <Field label={t('world.editor.lore.trigger.depth')}>
        <TextInput
          type="number"
          value={draft.trigger.depth}
          onChange={(value) => update({ trigger: { ...draft.trigger, depth: value } })}
        />
      </Field>
      <Field label={t('world.editor.lore.trigger.tokenBudget')} hint={t('world.editor.lore.trigger.tokenBudget.hint')}>
        <TextInput
          type="number"
          value={draft.trigger.tokenBudget}
          onChange={(value) => update({ trigger: { ...draft.trigger, tokenBudget: value } })}
        />
      </Field>
      <Field label={t('world.editor.lore.trigger.group')} hint={t('world.editor.lore.trigger.group.hint')}>
        <TextInput
          value={draft.trigger.group}
          onChange={(value) => update({ trigger: { ...draft.trigger, group: value } })}
        />
      </Field>
      <Field label={t('world.editor.lore.trigger.groupWeight')} hint={t('world.editor.lore.trigger.groupWeight.hint')}>
        <TextInput
          type="number"
          value={draft.trigger.groupWeight}
          onChange={(value) => update({ trigger: { ...draft.trigger, groupWeight: value } })}
        />
      </Field>
      <Field label={t('world.editor.lore.trigger.conditions')} hint={t('world.editor.lore.trigger.conditions.hint')}>
        <TextArea
          value={draft.trigger.conditions}
          onChange={(value) => update({ trigger: { ...draft.trigger, conditions: value } })}
          rows={3}
          placeholder={t('world.editor.lore.trigger.conditions.placeholder')}
        />
      </Field>
      <div className="world-pair">
        <Field label={t('world.editor.lore.trigger.sticky')} hint={t('world.editor.lore.trigger.sticky.hint')}>
          <TextInput
            type="number"
            value={draft.trigger.sticky}
            onChange={(value) => update({ trigger: { ...draft.trigger, sticky: value } })}
          />
        </Field>
        <Field label={t('world.editor.lore.trigger.cooldown')} hint={t('world.editor.lore.trigger.cooldown.hint')}>
          <TextInput
            type="number"
            value={draft.trigger.cooldown}
            onChange={(value) => update({ trigger: { ...draft.trigger, cooldown: value } })}
          />
        </Field>
      </div>
      <Field label={t('world.editor.lore.trigger.delay')} hint={t('world.editor.lore.trigger.delay.hint')}>
        <TextInput
          type="number"
          value={draft.trigger.delay}
          onChange={(value) => update({ trigger: { ...draft.trigger, delay: value } })}
        />
      </Field>
    </section>
  );
}
