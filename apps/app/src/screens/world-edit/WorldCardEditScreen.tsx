import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { validateCard, type CardIssue } from '../../../../../packages/cards/src/index.ts';
import { describeError } from '../../data/error-text.ts';
import { useT } from '../../i18n/context.tsx';
import type { Translator } from '../../i18n/locale.ts';
import { Banner, Button, ConfirmDialog, LoadingState } from '../../ui/components.tsx';
import type { AppStore } from '../../app/state.ts';
import type { WorldKind } from '../../app/router.ts';
import { BasicWorldSection } from './CommonSections.tsx';
import { ItemSections } from './ItemSections.tsx';
import { LoreSections } from './LoreSections.tsx';
import { SceneSections } from './SceneSections.tsx';
import { VisualsSection } from '../visuals-edit/VisualsSection.tsx';
import {
  buildCard,
  draftOfCard,
  emptyWorldDraft,
  referenceOptionsOf,
  type DraftCommon,
  type ItemDraft,
  type LoreDraft,
  type SceneDraft,
  type WorldCard,
  type WorldCardDraft,
  type WorldReferenceOptions,
} from './world-form.ts';

export interface WorldCardEditScreenProps {
  store: AppStore;
  kind: WorldKind;
  cardId: string | 'new';
  onDone: (cardId: string) => void;
}

const EMPTY_REFERENCES: WorldReferenceOptions = { scenes: [], characters: [], items: [] };

function issueLine(t: Translator, issue: CardIssue): string {
  return t('world.editor.issue', {
    path: issue.path === '' ? t('world.editor.root') : issue.path,
    message: issue.message,
  });
}

/**
 * 场景 / 物品 / 典籍编辑器（卡片模型 ADR-0011）。
 *
 * 与角色编辑器同一条流水线：读卡片 → 分区表单 → `buildCard`（保留表单不编辑的字段）
 * → `validateCard`（error 拦保存、warning 只提示）→ `cards.save` → 启停 → 返回列表。
 */
export function WorldCardEditScreen({ store, kind, cardId, onDone }: WorldCardEditScreenProps): ReactNode {
  const t = useT();
  const [existing, setExisting] = useState<WorldCard | undefined>(undefined);
  const [draft, setDraft] = useState<WorldCardDraft>(() => emptyWorldDraft(kind));
  const [references, setReferences] = useState<WorldReferenceOptions>(EMPTY_REFERENCES);
  /** 已知卡片 ID：给校验器的悬挂引用检查用（只报 warning，不拦保存）。 */
  const [knownIds, setKnownIds] = useState<ReadonlySet<string>>(new Set());
  const [enabled, setEnabled] = useState(true);
  const [initialEnabled, setInitialEnabled] = useState(true);
  const [loading, setLoading] = useState(cardId !== 'new');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [issues, setIssues] = useState<CardIssue[]>([]);
  const [pendingDelete, setPendingDelete] = useState(false);

  // 读卡片 + 库启停 + 引用下拉的可选项（其它卡片）。
  useEffect(() => {
    let alive = true;
    setIssues([]);
    setSaveError(undefined);
    setPendingDelete(false);
    const cards = store.repository.cards;
    if (cards === undefined) {
      setLoadError(t('world.editor.noCards'));
      setLoading(false);
      return;
    }
    const isNew = cardId === 'new';
    setLoadError(undefined);
    if (isNew) {
      // 新卡：只补引用下拉与启停，绝不清空用户已经输入的内容（组件复用时才重置草稿）
      setExisting(undefined);
      setDraft((current) => (current.kind === kind ? current : emptyWorldDraft(kind)));
      setEnabled(true);
      setInitialEnabled(true);
      setLoading(false);
    } else {
      setLoading(true);
    }
    void Promise.all([
      isNew ? Promise.resolve(undefined) : cards.get(cardId),
      isNew ? Promise.resolve([]) : cards.library(),
      cards.list(),
    ])
      .then(([card, library, allCards]) => {
        if (!alive) return;
        if (!isNew) {
          if (card !== undefined && card.card_type !== kind) {
            setLoadError(t('world.editor.wrongKind'));
            return;
          }
          if (card === undefined) {
            setLoadError(t('world.editor.notFound'));
            return;
          }
          const current = card as WorldCard;
          setExisting(current);
          setDraft(draftOfCard(current));
          const cardEnabled = library.find((entry) => entry.id === current.meta.id)?.enabled ?? true;
          setEnabled(cardEnabled);
          setInitialEnabled(cardEnabled);
        }
        setReferences(referenceOptionsOf(allCards));
        setKnownIds(new Set(allCards.map((entry) => entry.meta.id)));
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        // 新卡读不到引用列表不该挡住编辑：用可见的保存错误条说明，而不是整页替换
        if (isNew) setSaveError(describeError(cause));
        else setLoadError(describeError(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [store, kind, cardId, t]);

  const updateCommon = (patch: Partial<DraftCommon>): void => {
    setDraft((current) => ({ ...current, ...patch }) as WorldCardDraft);
  };
  const updateScene = (patch: Partial<SceneDraft>): void => {
    setDraft((current) => (current.kind === 'scene' ? { ...current, ...patch } : current));
  };
  const updateItem = (patch: Partial<ItemDraft>): void => {
    setDraft((current) => (current.kind === 'item' ? { ...current, ...patch } : current));
  };
  const updateLore = (patch: Partial<LoreDraft>): void => {
    setDraft((current) => (current.kind === 'lore' ? { ...current, ...patch } : current));
  };

  // 保存成功后立刻离开页面：warning 若只在"点保存时"算，就永远看不见。
  // 因此 warning 实时计算并常驻提示；error 仍在点保存后逐条展示（空表单别一进来就报一堆错）。
  const liveWarnings = useMemo(() => {
    if (draft.name.trim() === '' && draft.description.trim() === '') return [];
    const card = buildCard(existing, draft);
    return validateCard(card, { known_card_ids: knownIds }).issues.filter((issue) => issue.severity === 'warning');
  }, [existing, draft, knownIds]);

  const save = async (): Promise<void> => {
    const cards = store.repository.cards;
    if (cards === undefined) {
      setSaveError(t('world.editor.noCards'));
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    try {
      const card = buildCard(existing, draft);
      const validation = validateCard(card, { known_card_ids: knownIds });
      setIssues(validation.issues);
      if (!validation.ok) return;
      const saved = await cards.save(card);
      if (enabled !== initialEnabled) await cards.setEnabled(saved.meta.id, enabled);
      onDone(saved.meta.id);
    } catch (cause) {
      setSaveError(t('world.editor.saveFailed', { message: describeError(cause) }));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    const cards = store.repository.cards;
    if (cards === undefined || existing === undefined) return;
    setPendingDelete(false);
    try {
      await cards.remove(existing.meta.id);
      onDone('');
    } catch (cause) {
      setSaveError(t('world.editor.saveFailed', { message: describeError(cause) }));
    }
  };

  if (loading) return <LoadingState label={t('world.editor.loading')} />;
  if (loadError !== undefined) {
    return (
      <div className="form-screen">
        <div className="form">
          <Banner tone="error">{loadError}</Banner>
        </div>
      </div>
    );
  }

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = liveWarnings;
  const isNew = cardId === 'new' || existing === undefined;

  return (
    <div className="form-screen">
      <div className="form">
        {saveError !== undefined && <Banner tone="error">{saveError}</Banner>}
        {errors.length > 0 && (
          <Banner tone="error">
            <span>{t('world.editor.validationFailed')}</span>
            {errors.map((issue, index) => (
              <span key={`${issue.path}-${issue.code}-${String(index)}`}>
                <br />
                {issueLine(t, issue)}
              </span>
            ))}
          </Banner>
        )}
        {warnings.length > 0 && (
          <Banner tone="warn">
            <span>{t('world.editor.warnings')}</span>
            {warnings.map((issue, index) => (
              <span key={`${issue.path}-${issue.code}-${String(index)}`}>
                <br />
                {issueLine(t, issue)}
              </span>
            ))}
          </Banner>
        )}

        <BasicWorldSection draft={draft} update={updateCommon} enabled={enabled} onEnabledChange={setEnabled} />
        <VisualsSection drafts={draft.visuals} onChange={(next) => setDraft((current) => ({ ...current, visuals: next }))} />
        {draft.kind === 'scene' && <SceneSections draft={draft} update={updateScene} references={references} />}
        {draft.kind === 'item' && <ItemSections draft={draft} update={updateItem} />}
        {draft.kind === 'lore' && <LoreSections draft={draft} update={updateLore} />}

        {!isNew && (
          <div className="form__danger">
            <Button variant="ghost" onClick={() => setPendingDelete(true)}>
              {t('world.editor.delete')}
            </Button>
          </div>
        )}
      </div>

      <div className="actionbar">
        <Button block disabled={saving || draft.name.trim() === ''} onClick={() => void save()}>
          {saving ? t('world.editor.saveBusy') : t('world.editor.save')}
        </Button>
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title={t('world.editor.delete')}
        message={t('world.editor.delete.message', { name: existing?.meta.name ?? draft.name })}
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
