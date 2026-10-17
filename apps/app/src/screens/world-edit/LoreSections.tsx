import type { ReactNode } from 'react';
import type { LoreKind, LoreLogic } from '../../../../../packages/cards/src/index.ts';
import { useT } from '../../i18n/context.tsx';
import { Field, TextArea, TextInput } from '../../ui/components.tsx';
import type { LoreDraft } from './world-form.ts';

/**
 * 典籍（原世界书）分区：分类 / 内容 / 概述 / 触发词 / 匹配逻辑 / 触发策略。
 *
 * 关键词触发是典籍**唯一**适合的激活方式（设计文档 6.5）；条件表达式只保存源码，
 * 求值器尚未实现——界面上必须写清楚，不假装条件会生效。
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
      <label className="switch">
        <input
          type="checkbox"
          checked={draft.trigger.recursive}
          onChange={(event) => update({ trigger: { ...draft.trigger, recursive: event.target.checked } })}
        />
        <span>{t('world.editor.lore.trigger.recursive')}</span>
      </label>
      <Field label={t('world.editor.lore.trigger.depth')}>
        <TextInput
          type="number"
          value={draft.trigger.depth}
          onChange={(value) => update({ trigger: { ...draft.trigger, depth: value } })}
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
    </section>
  );
}
