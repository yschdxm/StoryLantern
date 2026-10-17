import type { ReactNode } from 'react';
import type { ItemKind, ItemRarity } from '../../../../../packages/cards/src/index.ts';
import { useT } from '../../i18n/context.tsx';
import { Field, TextArea, TextInput } from '../../ui/components.tsx';
import { ITEM_APPEARANCE_FIELDS, type ItemDraft } from './world-form.ts';

/**
 * 物品卡分区：类型 / 描述 / 功能 / 稀有度 / 价值 / 使用条件 / 耐久 / 外观。
 *
 * 物品的「定义层」只在卡里；持有者、耐久当前值等属于会话实例层（`runtime.patch`），
 * 编辑器不碰它们——设计文档 5.1 的关键一刀。
 */

const ITEM_KINDS: readonly ItemKind[] = [
  'weapon',
  'armor',
  'consumable',
  'quest',
  'tool',
  'clothing',
  'accessory',
  'vehicle',
  'key_item',
  'material',
  'other',
];

const ITEM_RARITIES: readonly ItemRarity[] = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'unique'];

export function ItemSections({
  draft,
  update,
}: {
  draft: ItemDraft;
  update: (patch: Partial<ItemDraft>) => void;
}): ReactNode {
  const t = useT();
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('world.editor.item.title')}</h2>
      <Field label={t('world.editor.item.type')}>
        <select
          className="input"
          value={draft.type}
          aria-label={t('world.editor.item.type')}
          onChange={(event) => update({ type: event.target.value as ItemKind })}
        >
          {ITEM_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`world.item.type.${kind}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`${t('world.editor.item.description')}*`} hint={t('world.editor.item.description.hint')}>
        <TextArea
          value={draft.descriptionText}
          onChange={(value) => update({ descriptionText: value })}
          rows={4}
          placeholder={t('world.editor.item.description.placeholder')}
        />
      </Field>
      <Field label={`${t('world.editor.item.function')}*`} hint={t('world.editor.item.function.hint')}>
        <TextArea
          value={draft.functionText}
          onChange={(value) => update({ functionText: value })}
          rows={3}
          placeholder={t('world.editor.item.function.placeholder')}
        />
      </Field>
      <Field label={t('world.editor.item.rarity')}>
        <select
          className="input"
          value={draft.rarity}
          aria-label={t('world.editor.item.rarity')}
          onChange={(event) => update({ rarity: event.target.value as ItemRarity | '' })}
        >
          <option value="">{t('world.editor.rarity.unset')}</option>
          {ITEM_RARITIES.map((rarity) => (
            <option key={rarity} value={rarity}>
              {t(`world.item.rarity.${rarity}`)}
            </option>
          ))}
        </select>
      </Field>

      <h3 className="settings-group__title">{t('world.editor.item.value')}</h3>
      <div className="world-pair">
        <Field label={t('world.editor.item.value.currency')}>
          <TextInput
            value={draft.value.currency}
            onChange={(value) => update({ value: { ...draft.value, currency: value } })}
            placeholder={t('world.editor.item.value.currency.placeholder')}
          />
        </Field>
        <Field label={t('world.editor.item.value.amount')}>
          <TextInput
            type="number"
            value={draft.value.amount}
            onChange={(value) => update({ value: { ...draft.value, amount: value } })}
          />
        </Field>
      </div>
      <Field label={t('world.editor.item.value.tradable')}>
        <select
          className="input"
          value={draft.value.tradable}
          aria-label={t('world.editor.item.value.tradable')}
          onChange={(event) =>
            update({ value: { ...draft.value, tradable: event.target.value as ItemDraft['value']['tradable'] } })
          }
        >
          <option value="unset">{t('world.editor.tristate.unset')}</option>
          <option value="yes">{t('world.editor.tristate.yes')}</option>
          <option value="no">{t('world.editor.tristate.no')}</option>
        </select>
      </Field>

      <h3 className="settings-group__title">{t('world.editor.item.usability')}</h3>
      <Field label={t('world.editor.item.usability.condition')}>
        <TextInput
          value={draft.usability.condition}
          onChange={(value) => update({ usability: { ...draft.usability, condition: value } })}
          placeholder={t('world.editor.item.usability.condition.placeholder')}
        />
      </Field>
      <Field label={t('world.editor.item.usability.maxUses')}>
        <TextInput
          type="number"
          value={draft.usability.maxUses}
          onChange={(value) => update({ usability: { ...draft.usability, maxUses: value } })}
        />
      </Field>

      <h3 className="settings-group__title">{t('world.editor.item.durability')}</h3>
      <Field label={t('world.editor.item.durability.max')}>
        <TextInput
          type="number"
          value={draft.durability.max}
          onChange={(value) => update({ durability: { ...draft.durability, max: value } })}
        />
      </Field>
      <Field label={t('world.editor.item.durability.repairable')}>
        <select
          className="input"
          value={draft.durability.repairable}
          aria-label={t('world.editor.item.durability.repairable')}
          onChange={(event) =>
            update({
              durability: { ...draft.durability, repairable: event.target.value as ItemDraft['durability']['repairable'] },
            })
          }
        >
          <option value="unset">{t('world.editor.tristate.unset')}</option>
          <option value="yes">{t('world.editor.tristate.yes')}</option>
          <option value="no">{t('world.editor.tristate.no')}</option>
        </select>
      </Field>
      <Field label={t('world.editor.item.durability.breakEffect')}>
        <TextInput
          value={draft.durability.breakEffect}
          onChange={(value) => update({ durability: { ...draft.durability, breakEffect: value } })}
          placeholder={t('world.editor.item.durability.breakEffect.placeholder')}
        />
      </Field>

      <h3 className="settings-group__title">{t('world.editor.item.appearance')}</h3>
      {ITEM_APPEARANCE_FIELDS.map((key) => (
        <Field key={key} label={t(`world.editor.item.appearance.${key}`)}>
          <TextInput
            value={draft.appearance[key] ?? ''}
            onChange={(value) => update({ appearance: { ...draft.appearance, [key]: value } })}
          />
        </Field>
      ))}
    </section>
  );
}
