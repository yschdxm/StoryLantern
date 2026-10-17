import type { ReactNode } from 'react';
import type { Rating } from '../../../../../packages/cards/src/index.ts';
import { useT } from '../../i18n/context.tsx';
import { Field, TextArea, TextInput } from '../../ui/components.tsx';
import type { DraftCommon, WorldCardDraft } from './world-form.ts';

/**
 * 三类世界资源共用的「基本信息」分区：名称 / 简介 / 标签 / 分级 / 语言 / 别名 / brief，
 * 以及库级启停。全部受控，状态由 `WorldCardEditScreen` 持有。
 */

function ratingOf(value: string): Rating {
  return value === 'teen' ? 'teen' : value === 'mature' ? 'mature' : 'general';
}

export function BasicWorldSection({
  draft,
  update,
  enabled,
  onEnabledChange,
}: {
  draft: WorldCardDraft;
  update: (patch: Partial<DraftCommon>) => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}): ReactNode {
  const t = useT();
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('world.editor.basic')}</h2>
      <Field label={`${t('world.editor.name')}*`} hint={t('world.editor.name.hint')}>
        <TextInput value={draft.name} onChange={(value) => update({ name: value })} placeholder={t('world.editor.name.placeholder')} />
      </Field>
      <Field label={`${t('world.editor.description')}*`} hint={t('world.editor.description.hint')}>
        <TextArea
          value={draft.description}
          onChange={(value) => update({ description: value })}
          rows={2}
          placeholder={t('world.editor.description.placeholder')}
        />
      </Field>
      <Field label={t('world.editor.tags')} hint={t('world.editor.tags.hint')}>
        <TextInput value={draft.tags} onChange={(value) => update({ tags: value })} placeholder={t('world.editor.tags.placeholder')} />
      </Field>
      <Field label={t('world.editor.aliases')} hint={t('world.editor.aliases.hint')}>
        <TextInput
          value={draft.aliases}
          onChange={(value) => update({ aliases: value })}
          placeholder={t('world.editor.aliases.placeholder')}
        />
      </Field>
      <Field label={t('world.editor.rating')}>
        <select
          className="input"
          value={draft.rating}
          aria-label={t('world.editor.rating')}
          onChange={(event) => update({ rating: ratingOf(event.target.value) })}
        >
          <option value="general">{t('world.rating.general')}</option>
          <option value="teen">{t('world.rating.teen')}</option>
          <option value="mature">{t('world.rating.mature')}</option>
        </select>
      </Field>
      <Field label={t('world.editor.language')} hint={t('world.editor.language.hint')}>
        <TextInput
          value={draft.language}
          onChange={(value) => update({ language: value })}
          placeholder={t('world.editor.language.placeholder')}
        />
      </Field>
      <Field label={t('world.editor.brief')} hint={t('world.editor.brief.hint')}>
        <TextArea
          value={draft.brief}
          onChange={(value) => update({ brief: value })}
          rows={2}
          placeholder={t('world.editor.brief.placeholder')}
        />
      </Field>
      <p className="world-note">{t('world.editor.visualsUnsupported')}</p>
      <label className="switch">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
        <span>{t('world.editor.enabled')}</span>
      </label>
      <p className="field__hint">{t('world.editor.enabled.hint')}</p>
    </section>
  );
}
