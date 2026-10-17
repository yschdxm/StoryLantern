import type { ReactNode } from 'react';
import { useT } from '../../i18n/context.tsx';
import { Button, Field, TextArea, TextInput } from '../../ui/components.tsx';
import {
  ATMOSPHERE_FIELDS,
  SCENE_APPEARANCE_FIELDS,
  type SceneConnectionDraft,
  type SceneDraft,
  type SceneOccupantDraft,
  type ScenePropDraft,
  type WorldReferenceOption,
  type WorldReferenceOptions,
} from './world-form.ts';

/**
 * 场景卡分区：类型 / 完整描述 / 外观 / 氛围 / 连接图 / 在场者 / 场景物品 / 事件 /
 * 默认公开状态 / 作为起始场景。
 *
 * 连接图是场景簿的价值核心（设计文档 4.4）：目标一律用卡片 ID 下拉选择；
 * 空行在保存时由 `world-form.ts` 丢弃，所以这里不拦用户留空。
 */

function ReferenceSelect({
  value,
  options,
  label,
  onChange,
  emptyHint,
}: {
  value: string;
  options: readonly WorldReferenceOption[];
  label: string;
  onChange: (value: string) => void;
  emptyHint: string;
}): ReactNode {
  const t = useT();
  const known = options.some((option) => option.id === value);
  return (
    <>
      <select className="input" value={value} aria-label={label} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('world.select.none')}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
        {value !== '' && !known && (
          <option value={value}>{`${value} ${t('world.select.missing')}`}</option>
        )}
      </select>
      {options.length === 0 && <span className="field__hint">{emptyHint}</span>}
    </>
  );
}

export function SceneSections({
  draft,
  update,
  references,
}: {
  draft: SceneDraft;
  update: (patch: Partial<SceneDraft>) => void;
  references: WorldReferenceOptions;
}): ReactNode {
  const t = useT();

  const updateConnection = (index: number, patch: Partial<SceneConnectionDraft>): void => {
    update({ connections: draft.connections.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)) });
  };
  const updateOccupant = (index: number, patch: Partial<SceneOccupantDraft>): void => {
    update({ occupants: draft.occupants.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)) });
  };
  const updateProp = (index: number, patch: Partial<ScenePropDraft>): void => {
    update({ props: draft.props.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)) });
  };
  const updateStatePair = (index: number, patch: Partial<{ key: string; value: string }>): void => {
    update({ defaultState: draft.defaultState.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)) });
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('world.editor.scene.title')}</h2>
      <Field label={t('world.editor.scene.type')}>
        <select
          className="input"
          value={draft.type}
          aria-label={t('world.editor.scene.type')}
          onChange={(event) => update({ type: event.target.value as SceneDraft['type'] })}
        >
          {(['physical', 'abstract', 'vehicle', 'dimension'] as const).map((type) => (
            <option key={type} value={type}>
              {t(`world.scene.type.${type}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`${t('world.editor.scene.description')}*`} hint={t('world.editor.scene.description.hint')}>
        <TextArea
          value={draft.sceneDescription}
          onChange={(value) => update({ sceneDescription: value })}
          rows={4}
          placeholder={t('world.editor.scene.description.placeholder')}
        />
      </Field>

      <h3 className="settings-group__title">{t('world.editor.scene.appearance')}</h3>
      {SCENE_APPEARANCE_FIELDS.map((key) => (
        <Field key={key} label={t(`world.editor.scene.appearance.${key}`)}>
          <TextInput
            value={draft.appearance[key] ?? ''}
            onChange={(value) => update({ appearance: { ...draft.appearance, [key]: value } })}
          />
        </Field>
      ))}

      <h3 className="settings-group__title">{t('world.editor.scene.atmosphere')}</h3>
      <p className="field__hint">{t('world.editor.scene.atmosphere.hint')}</p>
      {ATMOSPHERE_FIELDS.map((key) => (
        <Field key={key} label={t(`world.editor.scene.atmosphere.${key}`)}>
          <TextInput
            value={draft.atmosphere[key] ?? ''}
            onChange={(value) => update({ atmosphere: { ...draft.atmosphere, [key]: value } })}
          />
        </Field>
      ))}

      <h3 className="settings-group__title">{t('world.editor.scene.connections')}</h3>
      <p className="field__hint">{t('world.editor.scene.connections.hint')}</p>
      {draft.connections.map((row, index) => (
        <div className="world-row" key={`connection-${String(index)}`}>
          <div className="world-row__head">
            <span className="world-row__title">{`${t('world.editor.scene.connections')} ${String(index + 1)}`}</span>
            <Button variant="ghost" onClick={() => update({ connections: draft.connections.filter((_, i) => i !== index) })}>
              {t('world.editor.removeRow')}
            </Button>
          </div>
          <Field label={t('world.editor.scene.connections.target')}>
            <ReferenceSelect
              value={row.target}
              options={references.scenes}
              label={t('world.editor.scene.connections.target')}
              onChange={(value) => updateConnection(index, { target: value })}
              emptyHint={t('world.editor.scene.noScenes')}
            />
          </Field>
          <Field label={t('world.editor.scene.connections.direction')}>
            <select
              className="input"
              value={row.direction}
              aria-label={t('world.editor.scene.connections.direction')}
              onChange={(event) => updateConnection(index, { direction: event.target.value === 'one_way' ? 'one_way' : 'both' })}
            >
              <option value="both">{t('world.direction.both')}</option>
              <option value="one_way">{t('world.direction.one_way')}</option>
            </select>
          </Field>
          <Field label={t('world.editor.scene.connections.how')}>
            <TextInput
              value={row.how}
              onChange={(value) => updateConnection(index, { how: value })}
              placeholder={t('world.editor.scene.connections.how.placeholder')}
            />
          </Field>
          <Field label={t('world.editor.scene.connections.condition')}>
            <TextInput
              value={row.condition}
              onChange={(value) => updateConnection(index, { condition: value })}
              placeholder={t('world.editor.scene.connections.condition.placeholder')}
            />
          </Field>
        </div>
      ))}
      <Button
        variant="ghost"
        onClick={() => update({ connections: [...draft.connections, { target: '', direction: 'both', how: '', condition: '' }] })}
      >
        {t('world.editor.addRow')}
      </Button>

      <h3 className="settings-group__title">{t('world.editor.scene.occupants')}</h3>
      {draft.occupants.map((row, index) => (
        <div className="world-row" key={`occupant-${String(index)}`}>
          <div className="world-row__head">
            <span className="world-row__title">{`${t('world.editor.scene.occupants')} ${String(index + 1)}`}</span>
            <Button variant="ghost" onClick={() => update({ occupants: draft.occupants.filter((_, i) => i !== index) })}>
              {t('world.editor.removeRow')}
            </Button>
          </div>
          <Field label={t('world.editor.scene.occupants.target')}>
            <ReferenceSelect
              value={row.target}
              options={references.characters}
              label={t('world.editor.scene.occupants.target')}
              onChange={(value) => updateOccupant(index, { target: value })}
              emptyHint={t('world.editor.scene.noCharacters')}
            />
          </Field>
          <Field label={t('world.editor.scene.occupants.presence')}>
            <select
              className="input"
              value={row.presence}
              aria-label={t('world.editor.scene.occupants.presence')}
              onChange={(event) => updateOccupant(index, { presence: event.target.value as SceneOccupantDraft['presence'] })}
            >
              {(['resident', 'frequent', 'occasional', 'rare'] as const).map((presence) => (
                <option key={presence} value={presence}>
                  {t(`world.presence.${presence}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('world.editor.scene.occupants.when')}>
            <TextInput value={row.when} onChange={(value) => updateOccupant(index, { when: value })} />
          </Field>
          <Field label={t('world.editor.scene.occupants.note')}>
            <TextInput value={row.note} onChange={(value) => updateOccupant(index, { note: value })} />
          </Field>
        </div>
      ))}
      <Button
        variant="ghost"
        onClick={() =>
          update({ occupants: [...draft.occupants, { target: '', presence: 'resident', when: '', note: '' }] })
        }
      >
        {t('world.editor.addRow')}
      </Button>

      <h3 className="settings-group__title">{t('world.editor.scene.props')}</h3>
      {draft.props.map((row, index) => (
        <div className="world-row" key={`prop-${String(index)}`}>
          <div className="world-row__head">
            <span className="world-row__title">{`${t('world.editor.scene.props')} ${String(index + 1)}`}</span>
            <Button variant="ghost" onClick={() => update({ props: draft.props.filter((_, i) => i !== index) })}>
              {t('world.editor.removeRow')}
            </Button>
          </div>
          <Field label={t('world.editor.scene.props.item')}>
            <ReferenceSelect
              value={row.itemId}
              options={references.items}
              label={t('world.editor.scene.props.item')}
              onChange={(value) => updateProp(index, { itemId: value })}
              emptyHint={t('world.editor.scene.noItems')}
            />
          </Field>
          <Field label={t('world.editor.scene.props.note')}>
            <TextInput value={row.note} onChange={(value) => updateProp(index, { note: value })} />
          </Field>
        </div>
      ))}
      <Button variant="ghost" onClick={() => update({ props: [...draft.props, { itemId: '', note: '' }] })}>
        {t('world.editor.addRow')}
      </Button>

      <Field label={t('world.editor.scene.events')} hint={t('world.editor.scene.events.hint')}>
        <TextArea
          value={draft.events}
          onChange={(value) => update({ events: value })}
          rows={3}
          placeholder={t('world.editor.scene.events.placeholder')}
        />
      </Field>

      <h3 className="settings-group__title">{t('world.editor.scene.defaultState')}</h3>
      {draft.defaultState.map((row, index) => (
        <div className="world-pair" key={`state-${String(index)}`}>
          <Field label={t('world.editor.scene.defaultState.key')}>
            <TextInput value={row.key} onChange={(value) => updateStatePair(index, { key: value })} />
          </Field>
          <Field label={t('world.editor.scene.defaultState.value')}>
            <TextInput value={row.value} onChange={(value) => updateStatePair(index, { value })} />
          </Field>
          <Button variant="ghost" onClick={() => update({ defaultState: draft.defaultState.filter((_, i) => i !== index) })}>
            {t('world.editor.removeRow')}
          </Button>
        </div>
      ))}
      <Button variant="ghost" onClick={() => update({ defaultState: [...draft.defaultState, { key: '', value: '' }] })}>
        {t('world.editor.addRow')}
      </Button>

      <label className="switch">
        <input type="checkbox" checked={draft.isEntry} onChange={(event) => update({ isEntry: event.target.checked })} />
        <span>{t('world.editor.scene.isEntry')}</span>
      </label>
    </section>
  );
}
