import type { ReactNode } from 'react';
import type { ExampleDialogue, ExampleRole } from '../../../../../packages/cards/src/index.ts';
import {
  newCardId,
  type CharacterCardDraft,
  type SetCharacterDraftField,
} from '../../data/character-compat.ts';
import { useT } from '../../i18n/context.tsx';
import { Button, Field, TextArea, TextInput } from '../../ui/components.tsx';

/**
 * 语言分区 + 示例对话分区。
 *
 * 示例对话是「多组 × 多轮」的结构化编辑：每组可增删、每轮可改角色与正文。
 * 不用 JSON 粘贴——结构化是卡片模型的核心收益，界面必须能直接编辑它。
 */

const ROLES: readonly ExampleRole[] = ['user', 'assistant', 'narrator', 'system'];

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

export function SpeechSection({
  draft,
  set,
}: {
  draft: CharacterCardDraft;
  set: SetCharacterDraftField;
}): ReactNode {
  const t = useT();
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('character.editor.speech')}</h2>
      <Field label={`${t('character.editor.speechStyle')}*`} hint={t('character.editor.speechStyle.hint')}>
        <TextArea
          value={draft.speechStyle ?? ''}
          onChange={(value) => set('speechStyle', value)}
          rows={2}
          placeholder={t('character.editor.speechStyle.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.tone')}>
        <TextInput
          value={draft.tone ?? ''}
          onChange={(value) => set('tone', value)}
          placeholder={t('character.editor.tone.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.vocabulary')} hint={t('character.editor.vocabulary.hint')}>
        <TextArea
          value={joinLines(draft.vocabulary)}
          onChange={(value) => set('vocabulary', splitLines(value))}
          rows={2}
          placeholder={t('character.editor.vocabulary.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.forbiddenWords')} hint={t('character.editor.forbiddenWords.hint')}>
        <TextArea
          value={joinLines(draft.forbiddenWords)}
          onChange={(value) => set('forbiddenWords', splitLines(value))}
          rows={2}
          placeholder={t('character.editor.forbiddenWords.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.exampleLines')} hint={t('character.editor.exampleLines.hint')}>
        <TextArea
          value={joinLines(draft.exampleLines)}
          onChange={(value) => set('exampleLines', splitLines(value))}
          rows={3}
          placeholder={t('character.editor.exampleLines.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.narrationStyle')}>
        <TextArea
          value={draft.narrationStyle ?? ''}
          onChange={(value) => set('narrationStyle', value)}
          rows={2}
          placeholder={t('character.editor.narrationStyle.placeholder')}
        />
      </Field>
    </section>
  );
}

export function ExamplesSection({
  examples,
  onChange,
}: {
  examples: readonly ExampleDialogue[];
  onChange: (next: ExampleDialogue[]) => void;
}): ReactNode {
  const t = useT();

  const update = (groupIndex: number, next: ExampleDialogue): void => {
    onChange(examples.map((group, index) => (index === groupIndex ? next : group)));
  };

  const updateMessage = (
    groupIndex: number,
    messageIndex: number,
    patch: Partial<{ role: ExampleRole; content: string }>,
  ): void => {
    const group = examples[groupIndex];
    if (group === undefined) return;
    const messages = group.messages.map((message, index) => (index === messageIndex ? { ...message, ...patch } : message));
    update(groupIndex, { ...group, messages });
  };

  const removeMessage = (groupIndex: number, messageIndex: number): void => {
    const group = examples[groupIndex];
    if (group === undefined) return;
    update(groupIndex, { ...group, messages: group.messages.filter((_, index) => index !== messageIndex) });
  };

  const addGroup = (): void => {
    onChange([...examples, { id: newCardId('example'), messages: [{ role: 'assistant', content: '' }] }]);
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('character.editor.examples')}</h2>
      <p className="field__hint">{t('character.editor.examples.hint')}</p>
      {examples.length === 0 && <p className="muted">{t('character.editor.examples.empty')}</p>}
      {examples.map((group, groupIndex) => (
        <div className="settings-group" key={group.id}>
          <div className="row">
            <strong>{t('character.editor.examples.group', { n: groupIndex + 1 })}</strong>
            <Button variant="ghost" onClick={() => onChange(examples.filter((_, index) => index !== groupIndex))}>
              {t('character.editor.examples.remove')}
            </Button>
          </div>
          <Field label={t('character.editor.examples.context')}>
            <TextInput
              value={group.context ?? ''}
              onChange={(value) => update(groupIndex, { ...group, context: value })}
              placeholder={t('character.editor.examples.context.placeholder')}
            />
          </Field>
          <Field label={t('character.editor.examples.tags')} hint={t('character.editor.examples.tags.hint')}>
            <TextInput
              value={(group.tags ?? []).join(', ')}
              onChange={(value) => update(groupIndex, { ...group, tags: splitTags(value) })}
              placeholder={t('character.editor.examples.tags.placeholder')}
            />
          </Field>
          {group.messages.map((message, messageIndex) => (
            <div className="field" key={`${group.id}-${String(messageIndex)}`}>
              <span className="field__label">{t('character.editor.examples.message.content')}</span>
              <select
                className="input"
                value={message.role}
                aria-label={t('character.editor.examples.message.content')}
                onChange={(event) => updateMessage(groupIndex, messageIndex, { role: event.target.value as ExampleRole })}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`character.editor.role.${role}`)}
                  </option>
                ))}
              </select>
              <textarea
                className="textarea"
                rows={2}
                value={message.content}
                placeholder={t('character.editor.examples.message.content.placeholder')}
                onChange={(event) => updateMessage(groupIndex, messageIndex, { content: event.target.value })}
              />
              <Button variant="ghost" onClick={() => removeMessage(groupIndex, messageIndex)}>
                {t('character.editor.examples.message.remove')}
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            onClick={() => update(groupIndex, { ...group, messages: [...group.messages, { role: 'user', content: '' }] })}
          >
            {t('character.editor.examples.message.add')}
          </Button>
        </div>
      ))}
      <Button variant="ghost" onClick={addGroup}>
        {t('character.editor.examples.add')}
      </Button>
    </section>
  );
}
