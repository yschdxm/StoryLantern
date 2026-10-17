import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CardDocument, WorldPackManifest } from '../../../../../packages/cards/src/index.ts';
import { describeError } from '../../data/error-text.ts';
import { useT } from '../../i18n/context.tsx';
import type { AppStore } from '../../app/state.ts';
import { Banner, Button, ConfirmDialog, Field, Sheet, TextArea, TextInput } from '../../ui/components.tsx';
import { buildPack, draftOfPack, emptyPackDraft, toggleCard, type PackDraft } from './pack-form.ts';

export interface PackEditSheetProps {
  store: AppStore;
  open: boolean;
  /** `undefined` = 新建；否则编辑这个包。 */
  pack: WorldPackManifest | undefined;
  /** 可选卡片（全部卡片；世界包可以收任何类型）。 */
  cards: readonly CardDocument[];
  onClose: () => void;
  /** 保存/删除成功后让父级重新读列表。 */
  onChanged: () => void;
}

/**
 * 世界包编辑（Sheet 内联，不新增路由）。
 *
 * 世界包是发布单位：这里只编辑清单字段与"包含哪些卡片"；
 * **删除包不会删除卡片**（提示里写明），保存后由父级刷新列表。
 */
export function PackEditSheet({ store, open, pack, cards, onClose, onChanged }: PackEditSheetProps): ReactNode {
  const t = useT();
  const [draft, setDraft] = useState<PackDraft>(() => emptyPackDraft());
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);

  // 打开/切换包时重置表单：不能把上一个包的草稿带过来
  useEffect(() => {
    if (!open) return;
    setDraft(pack === undefined ? emptyPackDraft() : draftOfPack(pack));
    setQuery('');
    setError(undefined);
    setDeleteOpen(false);
    setNameTouched(false);
  }, [open, pack]);

  const patch = (change: Partial<PackDraft>): void => {
    setDraft((current) => ({ ...current, ...change }));
  };

  const visibleCards = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword === '') return cards;
    return cards.filter((card) => card.meta.name.toLowerCase().includes(keyword));
  }, [cards, query]);

  const packs = store.repository.packs;
  const nameMissing = draft.name.trim() === '';

  const save = async (): Promise<void> => {
    if (packs === undefined || nameMissing) return;
    setSaving(true);
    setError(undefined);
    try {
      await packs.save(buildPack(pack, draft, Date.now()));
      onChanged();
      onClose();
    } catch (cause) {
      setError(t('pack.saveFailed', { message: describeError(cause) }));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    setDeleteOpen(false);
    if (packs === undefined || pack === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      await packs.remove(pack.id);
      onChanged();
      onClose();
    } catch (cause) {
      setError(t('pack.deleteFailed', { message: describeError(cause) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Sheet open={open} title={pack === undefined ? t('pack.new') : t('pack.edit.title', { name: pack.name })} onClose={onClose}>
        <div className="sheet__form">
          {error !== undefined && <Banner tone="error">{error}</Banner>}
          {packs === undefined && <Banner tone="warn">{t('pack.noStore')}</Banner>}

          <Field
            label={t('pack.field.name')}
            {...(nameTouched && nameMissing ? { hint: t('pack.field.name.required') } : {})}
          >
            <TextInput
              value={draft.name}
              onChange={(value) => patch({ name: value })}
              onBlur={() => setNameTouched(true)}
              placeholder={t('pack.field.name.placeholder')}
              autoFocus
            />
          </Field>
          <div className="world-pair">
            <Field label={t('pack.field.version')}>
              <TextInput value={draft.version} onChange={(value) => patch({ version: value })} />
            </Field>
            <Field label={t('pack.field.language')}>
              <TextInput value={draft.language} onChange={(value) => patch({ language: value })} />
            </Field>
          </div>
          <Field label={t('pack.field.description')}>
            <TextArea value={draft.description} onChange={(value) => patch({ description: value })} rows={2} placeholder={t('pack.field.description.placeholder')} />
          </Field>
          <div className="world-pair">
            <Field label={t('pack.field.author')}>
              <TextInput value={draft.author} onChange={(value) => patch({ author: value })} />
            </Field>
            <Field label={t('pack.field.license')}>
              <TextInput value={draft.license} onChange={(value) => patch({ license: value })} />
            </Field>
          </div>
          <Field label={t('pack.field.tags')} hint={t('pack.field.tags.hint')}>
            <TextInput value={draft.tags} onChange={(value) => patch({ tags: value })} />
          </Field>

          <Field label={t('pack.cards.title')} hint={t('pack.cards.hint', { count: draft.card_ids.length })}>
            <TextInput value={query} onChange={setQuery} placeholder={t('pack.cards.search')} />
          </Field>
          {cards.length === 0 ? (
            <p className="muted">{t('pack.cards.empty')}</p>
          ) : visibleCards.length === 0 ? (
            <p className="muted">{t('pack.cards.noMatch')}</p>
          ) : (
            <div className="pack-cards">
              {visibleCards.map((card) => (
                <label className="switch pack-card" key={card.meta.id}>
                  <input
                    type="checkbox"
                    checked={draft.card_ids.includes(card.meta.id)}
                    onChange={() => patch({ card_ids: toggleCard(draft.card_ids, card.meta.id) })}
                  />
                  <span>
                    <span className="pack-card__name">{card.meta.name}</span>
                    <span className="pack-card__type">{t(`pack.cardType.${card.card_type}`)}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {draft.card_ids.length === 0 && <p className="notice notice--warn">{t('pack.warning.noCards')}</p>}

          <div className="row">
            <Button disabled={saving || nameMissing || packs === undefined} onClick={() => void save()}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
          </div>

          {pack !== undefined && (
            <div className="form__danger">
              <p className="field__hint">{t('pack.delete.hint')}</p>
              <Button variant="danger" disabled={saving || packs === undefined} onClick={() => setDeleteOpen(true)}>
                {t('pack.delete')}
              </Button>
            </div>
          )}
        </div>
      </Sheet>

      <ConfirmDialog
        open={deleteOpen}
        title={t('pack.delete.title')}
        message={t('pack.delete.message', { name: pack?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => void remove()}
      />
    </>
  );
}
