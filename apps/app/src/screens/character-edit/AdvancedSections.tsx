import type { ReactNode } from 'react';
import type { StateVarType } from '../../../../../packages/cards/src/index.ts';
import type { CharacterCardDraft, SetCharacterDraftField } from '../../data/character-compat.ts';
import { useT } from '../../i18n/context.tsx';
import type { StateVariableDraft } from './form-state.tsx';
import { Button, Field, TextArea, TextInput } from '../../ui/components.tsx';

/**
 * 状态变量表格 + 高级分区。
 *
 * 状态变量只编辑**模式**（变量名/类型/默认值/范围/可见性）；具体数值属于会话运行时
 * （`runtime.patch`），编辑卡片不写值——这是 ADR-0011 的取舍，界面上必须说清楚。
 */

const VAR_TYPES: readonly StateVarType[] = ['integer', 'string', 'boolean', 'array'];

function typeOf(value: string): StateVarType {
  return value === 'string' || value === 'boolean' || value === 'array' ? value : 'integer';
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function joinLines(items: readonly string[] | undefined): string {
  return (items ?? []).join('\n');
}

export function StateSection({
  variables,
  onChange,
}: {
  variables: readonly StateVariableDraft[];
  onChange: (next: StateVariableDraft[]) => void;
}): ReactNode {
  const t = useT();
  const update = (index: number, patch: Partial<StateVariableDraft>): void => {
    onChange(variables.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('character.editor.state')}</h2>
      <p className="field__hint">{t('character.editor.state.hint')}</p>
      {variables.length === 0 && <p className="muted">{t('character.editor.state.empty')}</p>}
      {variables.map((variable, index) => (
        <div className="settings-group" key={String(index)}>
          <div className="row">
            <strong>{variable.name.trim() === '' ? t('character.editor.state.name') : variable.name}</strong>
            <Button variant="ghost" onClick={() => onChange(variables.filter((_, itemIndex) => itemIndex !== index))}>
              {t('character.editor.state.remove')}
            </Button>
          </div>
          <Field label={t('character.editor.state.name')}>
            <TextInput
              value={variable.name}
              onChange={(value) => update(index, { name: value })}
              placeholder={t('character.editor.state.name.placeholder')}
            />
          </Field>
          <Field label={t('character.editor.state.type')}>
            <select
              className="input"
              value={variable.type}
              aria-label={t('character.editor.state.type')}
              onChange={(event) => update(index, { type: typeOf(event.target.value) })}
            >
              {VAR_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`character.editor.state.type.${type}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('character.editor.state.default')} hint={t('character.editor.state.default.hint')}>
            <TextInput value={variable.defaultText} onChange={(value) => update(index, { defaultText: value })} />
          </Field>
          {variable.type === 'integer' && (
            <>
              <Field label={t('character.editor.state.min')}>
                <TextInput
                  type="number"
                  value={variable.min}
                  onChange={(value) => update(index, { min: value })}
                />
              </Field>
              <Field label={t('character.editor.state.max')}>
                <TextInput
                  type="number"
                  value={variable.max}
                  onChange={(value) => update(index, { max: value })}
                />
              </Field>
            </>
          )}
          <label className="switch">
            <input
              type="checkbox"
              checked={variable.visible}
              onChange={(event) => update(index, { visible: event.target.checked })}
            />
            <span>{t('character.editor.state.visible')}</span>
          </label>
        </div>
      ))}
      <Button
        variant="ghost"
        onClick={() =>
          onChange([
            ...variables,
            { name: '', type: 'integer', defaultText: '0', min: '', max: '', visible: true },
          ])
        }
      >
        {t('character.editor.state.add')}
      </Button>
    </section>
  );
}

export function AdvancedSection({
  draft,
  set,
  enabled,
  onEnabledChange,
}: {
  draft: CharacterCardDraft;
  set: SetCharacterDraftField;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}): ReactNode {
  const t = useT();
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('character.editor.advanced')}</h2>
      <Field label={t('character.editor.advanced.systemExtra')} hint={t('character.editor.advanced.systemExtra.hint')}>
        <TextArea
          value={draft.systemExtra ?? ''}
          onChange={(value) => set('systemExtra', value)}
          rows={3}
          placeholder={t('character.editor.advanced.systemExtra.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.advanced.roleplayRules')} hint={t('character.editor.advanced.roleplayRules.hint')}>
        <TextArea
          value={joinLines(draft.roleplayRules)}
          onChange={(value) => set('roleplayRules', splitLines(value))}
          rows={3}
          placeholder={t('character.editor.advanced.roleplayRules.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.advanced.styleGuide')}>
        <TextArea
          value={draft.styleGuide ?? ''}
          onChange={(value) => set('styleGuide', value)}
          rows={2}
          placeholder={t('character.editor.advanced.styleGuide.placeholder')}
        />
      </Field>
      <Field label={t('character.editor.advanced.brief')} hint={t('character.editor.advanced.brief.hint')}>
        <TextArea
          value={draft.brief ?? ''}
          onChange={(value) => set('brief', value)}
          rows={2}
          placeholder={t('character.editor.advanced.brief.placeholder')}
        />
      </Field>
      <label className="switch">
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
        <span>{t('character.editor.enabled')}</span>
      </label>
      <p className="field__hint">{t('character.editor.enabled.hint')}</p>
    </section>
  );
}
