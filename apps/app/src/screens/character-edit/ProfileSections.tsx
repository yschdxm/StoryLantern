import type { ReactNode } from 'react';
import type { Rating } from '../../../../../packages/cards/src/index.ts';
import type { CharacterCardDraft, SetCharacterDraftField } from '../../data/character-compat.ts';
import { useT } from '../../i18n/context.tsx';
import { Field, TextArea, TextInput } from '../../ui/components.tsx';

/**
 * 角色编辑器的前三个分区：基本信息 / 身份 / 人格。
 *
 * 全部是受控字段：状态由 `CharacterEditScreen` 持有，这里只做展示与事件转发。
 * 分区标题用 `settings-group` 的既有样式（L2 分节），不引入新的视觉语言。
 */

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function joinLines(items: readonly string[] | undefined): string {
  return (items ?? []).join('\n');
}

function splitTags(value: string): string[] {
  return value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function ratingOf(value: string): Rating {
  return value === 'teen' ? 'teen' : value === 'mature' ? 'mature' : 'general';
}

export function BasicSection({
  draft,
  set,
}: {
  draft: CharacterCardDraft;
  set: SetCharacterDraftField;
}): ReactNode {
  const t = useT();
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('character.editor.basic')}</h2>
      <Field label={`${t('character.name')}*`} hint={t('character.name.hint')}>
        <TextInput value={draft.name} onChange={(value) => set('name', value)} placeholder={t('character.name.placeholder')} testId="character-name" />
      </Field>
      <Field label={`${t('character.editor.description')}*`} hint={t('character.editor.description.hint')}>
        <TextArea
          value={draft.description ?? ''}
          onChange={(value) => set('description', value)}
          rows={2}
          placeholder={t('character.editor.description.placeholder')}
          testId="character-description"
        />
      </Field>
      <Field label={t('character.editor.tags')} hint={t('character.editor.tags.hint')}>
        <TextInput
          value={(draft.tags ?? []).join(', ')}
          onChange={(value) => set('tags', splitTags(value))}
          placeholder={t('character.editor.tags.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.rating')} hint={t('character.editor.rating.hint')}>
        <select
          className="input"
          value={draft.rating ?? 'general'}
          aria-label={t('character.editor.rating')}
          onChange={(event) => set('rating', ratingOf(event.target.value))}
        >
          <option value="general">{t('character.editor.rating.general')}</option>
          <option value="teen">{t('character.editor.rating.teen')}</option>
          <option value="mature">{t('character.editor.rating.mature')}</option>
        </select>
      </Field>
      <Field label={t('character.editor.language')} hint={t('character.editor.language.hint')}>
        <TextInput
          value={draft.language ?? 'zh-CN'}
          onChange={(value) => set('language', value)}
          placeholder={t('character.editor.language.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.summary')} hint={t('character.editor.summary.hint')}>
        <TextInput
          value={draft.personalitySummary ?? ''}
          onChange={(value) => set('personalitySummary', value)}
          placeholder={t('character.editor.summary.placeholder')}
        />
      </Field>
    </section>
  );
}

export function IdentitySection({
  draft,
  set,
}: {
  draft: CharacterCardDraft;
  set: SetCharacterDraftField;
}): ReactNode {
  const t = useT();
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('character.editor.identity')}</h2>
      <Field label={`${t('character.editor.background')}*`} hint={t('character.editor.background.hint')}>
        <TextArea
          value={draft.background ?? ''}
          onChange={(value) => set('background', value)}
          rows={5}
          placeholder={t('character.editor.background.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.occupation')}>
        <TextInput
          value={draft.occupation ?? ''}
          onChange={(value) => set('occupation', value)}
          placeholder={t('character.editor.occupation.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.species')}>
        <TextInput
          value={draft.species ?? ''}
          onChange={(value) => set('species', value)}
          placeholder={t('character.editor.species.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.age')}>
        <TextInput
          value={draft.age ?? ''}
          onChange={(value) => set('age', value)}
          placeholder={t('character.editor.age.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.gender')}>
        <TextInput
          value={draft.gender ?? ''}
          onChange={(value) => set('gender', value)}
          placeholder={t('character.editor.gender.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.location')} hint={t('character.editor.location.hint')}>
        <TextInput
          value={draft.location ?? ''}
          onChange={(value) => set('location', value)}
          placeholder={t('character.editor.location.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.appearance')}>
        <TextInput
          value={draft.appearanceSummary ?? ''}
          onChange={(value) => set('appearanceSummary', value)}
          placeholder={t('character.editor.appearance.placeholder')}
        />
      </Field>
    </section>
  );
}

export function PersonaSection({
  draft,
  set,
}: {
  draft: CharacterCardDraft;
  set: SetCharacterDraftField;
}): ReactNode {
  const t = useT();
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('character.editor.persona')}</h2>
      <Field label={t('character.editor.traits')} hint={t('character.editor.traits.hint')}>
        <TextArea
          value={joinLines(draft.traits)}
          onChange={(value) => set('traits', splitLines(value))}
          rows={3}
          placeholder={t('character.editor.traits.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.goals')} hint={t('character.editor.goals.hint')}>
        <TextArea
          value={joinLines(draft.goals)}
          onChange={(value) => set('goals', splitLines(value))}
          rows={2}
          placeholder={t('character.editor.goals.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.fears')} hint={t('character.editor.fears.hint')}>
        <TextArea
          value={joinLines(draft.fears)}
          onChange={(value) => set('fears', splitLines(value))}
          rows={2}
          placeholder={t('character.editor.fears.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.taboos')} hint={t('character.editor.taboos.hint')}>
        <TextArea
          value={joinLines(draft.taboos)}
          onChange={(value) => set('taboos', splitLines(value))}
          rows={2}
          placeholder={t('character.editor.taboos.placeholder')}
        />
      </Field>
      <Field label={`${t('character.editor.knowledgeBoundary')}*`} hint={t('character.editor.knowledgeBoundary.hint')}>
        <TextArea
          value={draft.knowledgeBoundary ?? ''}
          onChange={(value) => set('knowledgeBoundary', value)}
          rows={2}
          placeholder={t('character.editor.knowledgeBoundary.placeholder')}
        />
      </Field>
      <Field label={`${t('character.editor.abilityBoundary')}*`} hint={t('character.editor.abilityBoundary.hint')}>
        <TextArea
          value={draft.abilityBoundary ?? ''}
          onChange={(value) => set('abilityBoundary', value)}
          rows={2}
          placeholder={t('character.editor.abilityBoundary.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.mood')}>
        <TextInput
          value={draft.mood ?? ''}
          onChange={(value) => set('mood', value)}
          placeholder={t('character.editor.mood.placeholder')}
        />
      </Field>
    </section>
  );
}
