import { useEffect, useState, type ReactNode } from 'react';
import {
  validateCard,
  type CardIssue,
  type CharacterCard,
  type ExampleDialogue,
} from '../../../../packages/cards/src/index.ts';
import {
  applyDraftToCard,
  type CharacterCardDraft,
  type SetCharacterDraftField,
} from '../data/character-compat.ts';
import {
  attachRulesToCard,
  attachVisuals,
  draftOfCard,
  ruleDraftsOf,
  stateSchemaOfDrafts,
  stateVariableDraftsOf,
  type StateVariableDraft,
  visualDraftsOf,
} from './character-edit/form-state.tsx';
import type { VisualDraft } from '../data/visuals-form.ts';
import type { RuleDraft } from '../data/rules-form.ts';
import { VisualsSection } from './visuals-edit/VisualsSection.tsx';
import { RulesSection } from './rules-edit/RulesSection.tsx';
import { describeError } from '../data/error-text.ts';
import { useT } from '../i18n/context.tsx';
import type { Translator } from '../i18n/locale.ts';
import type { ScreenProps } from './screen-props.ts';
import { Banner, Button, ConfirmDialog, LoadingState } from '../ui/components.tsx';
import { BasicSection, IdentitySection, PersonaSection } from './character-edit/ProfileSections.tsx';
import { AdvancedSection, StateSection } from './character-edit/AdvancedSections.tsx';
import { ExamplesSection, SpeechSection } from './character-edit/VoiceSections.tsx';

export interface CharacterEditScreenProps extends ScreenProps {
  characterId: string | 'new';
  onDone: (characterId: string) => void;
}

/** 校验问题的一条：`路径：人话原因`（路径为空 = 整张卡）。 */
function issueLine(t: Translator, issue: CardIssue): string {
  return t('character.editor.issue', {
    path: issue.path === '' ? t('character.editor.root') : issue.path,
    message: issue.message,
  });
}

/** 清空状态变量：行被全部删掉时不能把旧 state 留在卡里。 */
function withoutState(card: CharacterCard): CharacterCard {
  if (card.state === undefined) return card;
  const { state: _state, ...rest } = card;
  return rest;
}

/**
 * 角色编辑器（卡片模型 ADR-0011）。
 *
 * 与旧版的三点不同：
 *  1. **按分区编辑结构化字段**，不再是一块 JSON / 六个大文本框；
 *  2. 保存写的是**卡片**（`repository.cards.save`），旧字段（scenario/开场白）交给兼容草稿；
 *  3. 保存前跑 `validateCard`：error 逐条列出且不保存，warning 只提示。
 *
 * 库级启停（`setEnabled`）也在保存时一并落地：停用的卡保留内容，但不参与会话。
 */
export function CharacterEditScreen({ store, characterId, onDone }: CharacterEditScreenProps): ReactNode {
  const t = useT();
  const [existing, setExisting] = useState<CharacterCard | undefined>(undefined);
  const [draft, setDraft] = useState<CharacterCardDraft>({ name: '' });
  const [examples, setExamples] = useState<ExampleDialogue[]>([]);
  const [variables, setVariables] = useState<StateVariableDraft[]>([]);
  const [visuals, setVisuals] = useState<VisualDraft[]>([]);
  const [rules, setRules] = useState<RuleDraft[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [initialEnabled, setInitialEnabled] = useState(true);
  const [loading, setLoading] = useState(characterId !== 'new');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [issues, setIssues] = useState<CardIssue[]>([]);
  const [pendingDelete, setPendingDelete] = useState(false);

  // 打开编辑器：读卡片 + 库启停状态。异步到达后只填充一次，不覆盖正在输入的内容。
  useEffect(() => {
    let alive = true;
    setIssues([]);
    setSaveError(undefined);
    setPendingDelete(false);
    if (characterId === 'new') {
      // 同一组件实例可能从"编辑 A"切到"新建"：显式清空，别把上一个角色的表单带过来
      setExisting(undefined);
      setDraft({ name: '' });
      setExamples([]);
      setVariables([]);
      setVisuals([]);
      setRules([]);
      setEnabled(true);
      setInitialEnabled(true);
      setLoadError(undefined);
      setLoading(false);
      return;
    }
    const cards = store.repository.cards;
    if (cards === undefined) {
      setLoadError(t('character.editor.noCards'));
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(undefined);
    void Promise.all([cards.get(characterId), cards.library()])
      .then(([card, library]) => {
        if (!alive) return;
        if (card === undefined || card.card_type !== 'character') {
          setLoadError(t('character.editor.notFound'));
          return;
        }
        const cardEnabled = library.find((entry) => entry.id === card.meta.id)?.enabled ?? true;
        setExisting(card);
        setDraft(draftOfCard(card));
        setExamples(card.examples === undefined ? [] : [...card.examples]);
        setVariables(stateVariableDraftsOf(card.state));
        setVisuals(visualDraftsOf(card));
        setRules(ruleDraftsOf(card));
        setEnabled(cardEnabled);
        setInitialEnabled(cardEnabled);
      })
      .catch((cause: unknown) => {
        if (alive) setLoadError(describeError(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [characterId, store, t]);

  const set: SetCharacterDraftField = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async (): Promise<void> => {
    const cards = store.repository.cards;
    if (cards === undefined) {
      setSaveError(t('character.editor.noCards'));
      return;
    }
    setSaving(true);
    setSaveError(undefined);
    try {
      const base = applyDraftToCard(existing, draft);
      const state = stateSchemaOfDrafts(variables);
      const withLists: CharacterCard = { ...base, examples };
      const withVisuals = attachVisuals(withLists, visuals);
      const withRules = attachRulesToCard(withVisuals, rules);
      const card: CharacterCard = state === undefined ? withoutState(withRules) : { ...withRules, state };
      const validation = validateCard(card);
      setIssues(validation.issues);
      if (!validation.ok) return;
      const saved = await cards.save(card);
      // 库级启停与卡片内容分开存；保存时一并落地，避免"编辑完还要回列表再停一次"
      if (enabled !== initialEnabled) await cards.setEnabled(saved.meta.id, enabled);
      // 写的是卡片仓储（不是旧的 saveCharacter action）：列表状态要显式刷新，否则回列表还是旧数据
      await store.actions.refreshCharacters();
      onDone(saved.meta.id);
    } catch (cause) {
      setSaveError(t('character.editor.saveFailed', { message: describeError(cause) }));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState label={t('character.editor.loading')} />;
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
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  const isNew = existing === undefined;

  return (
    <div className="form-screen">
      <div className="form">
        {saveError !== undefined && <Banner tone="error">{saveError}</Banner>}
        {errors.length > 0 && (
          <Banner tone="error">
            <span>{t('character.editor.validationFailed')}</span>
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
            <span>{t('character.editor.warnings')}</span>
            {warnings.map((issue, index) => (
              <span key={`${issue.path}-${issue.code}-${String(index)}`}>
                <br />
                {issueLine(t, issue)}
              </span>
            ))}
          </Banner>
        )}

        <BasicSection draft={draft} set={set} />
        <IdentitySection draft={draft} set={set} />
        <PersonaSection draft={draft} set={set} />
        <SpeechSection draft={draft} set={set} />
        <VisualsSection drafts={visuals} onChange={setVisuals} />
        <ExamplesSection examples={examples} onChange={setExamples} />
        <StateSection variables={variables} onChange={setVariables} />
        <AdvancedSection draft={draft} set={set} enabled={enabled} onEnabledChange={setEnabled} />
        <RulesSection rules={rules} onChange={setRules} titleKey="rules.title" />

        {!isNew && (
          <div className="form__danger">
            <Button variant="ghost" onClick={() => setPendingDelete(true)}>
              {t('character.delete')}
            </Button>
          </div>
        )}
      </div>

      <div className="actionbar">
        <Button block disabled={saving || draft.name.trim() === ''} onClick={() => void save()}>
          {saving ? t('character.editor.saveBusy') : t('character.editor.save')}
        </Button>
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title={t('characters.delete')}
        message={t('characters.delete.message', { name: existing?.identity.name ?? draft.name })}
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          setPendingDelete(false);
          void store.actions.deleteCharacter(characterId);
          onDone('');
        }}
      />
    </div>
  );
}
