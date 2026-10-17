import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  TONES,
  type CardDocument,
  type CharacterCard,
  type ItemCard,
  type LoreCard,
  type OpeningMode,
  type SceneCard,
  type SessionSetup,
  type Tone,
  type WorldPackManifest,
} from '../../../../packages/cards/src/index.ts';
import type { AssembleFn } from '../../../../plugins/writing-pipeline/src/index.ts';
import type { ChatClient } from '../data/chat-client.ts';
import {
  composeSessionSetup,
  generateOpening,
  loadSessionCreateResources,
  openingCardsFor,
  previewOpeningRuntime,
} from '../data/auto-opening.ts';
import { describeError } from '../data/error-text.ts';
import { isModelConfigured } from '../data/repository.ts';
import { useT } from '../i18n/context.tsx';
import type { Translator } from '../i18n/locale.ts';
import type { AppStore } from '../app/state.ts';
import type { Router } from '../app/router.ts';
import { useAppState } from './screen-props.ts';
import { Banner, Button, Field, LoadingState, TextArea, TextInput } from '../ui/components.tsx';

export interface SessionCreateScreenProps {
  store: AppStore;
  router: Router;
  /** 从角色页/角色卡进入时预选这个成员。 */
  initialCharacterId?: string;
  /** 模型调用（智能开场）。缺省 = 不能生成，auto 选项禁用。 */
  chat?: ChatClient;
  /** 组合出来的上下文管线；缺省 = 装配走兜底拼接。 */
  assemble?: AssembleFn;
}

interface MemberOption {
  id: string;
  name: string;
  subtitle: string;
}

interface ResourceOption {
  id: string;
  name: string;
  kindLabel: string;
}

type OpeningChoice = 'designated' | 'self' | 'auto';

const clip = (text: string, limit = 60): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};
const toggleId = (list: readonly string[], id: string): string[] =>
  list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
const characterSubtitle = (card: CharacterCard): string =>
  clip(card.persona.summary.trim() !== '' ? card.persona.summary : card.identity.background);
function resourceKindLabel(t: Translator, card: SceneCard | ItemCard | LoreCard): string {
  if (card.card_type === 'scene') return t(`world.scene.type.${card.type}`);
  if (card.card_type === 'item') return t(`world.item.type.${card.type}`);
  return t(`world.lore.kind.${card.kind}`);
}

/**
 * 会话创建（卡片模型 ADR-0011）：成员 + 这一局处境 + 资源池 + 开场模式 → `SessionSetup`。
 * 开场三种模式：指定 / 用户 / 智能。智能开场失败**不阻塞创建**：仍按"用户开场"建会话，
 * 并在本页 Banner 如实说明原因（不假装生成过）。
 */
export function SessionCreateScreen({
  store,
  router,
  initialCharacterId,
  chat,
  assemble,
}: SessionCreateScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [cardsMissing, setCardsMissing] = useState(false);
  const [packsMissing, setPacksMissing] = useState(false);
  const [allCards, setAllCards] = useState<CardDocument[]>([]);
  const [libraryEnabled, setLibraryEnabled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [cardMembers, setCardMembers] = useState<MemberOption[]>([]);
  const [scenes, setScenes] = useState<SceneCard[]>([]);
  const [resources, setResources] = useState<ResourceOption[]>([]);
  const [packs, setPacks] = useState<WorldPackManifest[]>([]);
  // 选择态
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionTouched, setSelectionTouched] = useState(false);
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const [userRole, setUserRole] = useState('');
  const [setting, setSetting] = useState('');
  const [tone, setTone] = useState<Tone | ''>('');
  const [packIds, setPackIds] = useState<string[]>([]);
  const [cardIds, setCardIds] = useState<string[]>([]);
  const [sceneId, setSceneId] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<OpeningChoice>('designated');
  const [speaker, setSpeaker] = useState<string | undefined>(undefined);
  const [openingInput, setOpeningInput] = useState('');
  // 提交态
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [openingNotice, setOpeningNotice] = useState<string | undefined>(undefined);
  /** 开场生成失败但会话已建：按钮变成"进入会话"，Banner 停在本页。 */
  const [createdSessionId, setCreatedSessionId] = useState<string | undefined>(undefined);

  // 读角色/场景/资源/世界包/库启停。卡片仓储缺失时成员退回旧 `characters`（兼容视图）。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(undefined);
    setPacksMissing(store.repository.packs === undefined);
    void loadSessionCreateResources(store.repository)
      .then((loaded) => {
        if (!alive) return;
        if (loaded === undefined) {
          setCardsMissing(true);
          return;
        }
        setCardsMissing(false);
        setAllCards(loaded.cards);
        setLibraryEnabled(new Map(loaded.library.map((entry) => [entry.id, entry.enabled])));
        setCardMembers(
          loaded.cards
            .filter((card): card is CharacterCard => card.card_type === 'character')
            .map((card) => ({ id: card.meta.id, name: card.identity.name, subtitle: characterSubtitle(card) })),
        );
        setScenes(loaded.cards.filter((card): card is SceneCard => card.card_type === 'scene'));
        setResources(
          loaded.cards.flatMap((card): ResourceOption[] =>
            card.card_type === 'scene' || card.card_type === 'item' || card.card_type === 'lore'
              ? [{ id: card.meta.id, name: card.meta.name, kindLabel: resourceKindLabel(t, card) }]
              : [],
          ),
        );
        setPacks(loaded.packs);
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
  }, [store, t]);

  const members = useMemo<MemberOption[]>(
    () =>
      cardsMissing
        ? state.characters.map((character) => ({
            id: character.id,
            name: character.name,
            subtitle: clip(character.description || character.personality),
          }))
        : cardMembers,
    [cardsMissing, cardMembers, state.characters],
  );

  // 默认勾选：initialCharacterId 优先，否则第一个角色；用户手动改过之后不再自动补。
  useEffect(() => {
    if (selectionTouched || selected.length > 0 || members.length === 0) return;
    const preferred =
      initialCharacterId !== undefined && members.some((member) => member.id === initialCharacterId)
        ? initialCharacterId
        : members[0]?.id;
    if (preferred !== undefined) setSelected([preferred]);
  }, [members, initialCharacterId, selectionTouched, selected.length]);

  // 指定开场的开口角色必须是当前成员；成员变化时回落到第一个。
  useEffect(() => {
    if (selected.length === 0) {
      if (speaker !== undefined) setSpeaker(undefined);
    } else if (speaker === undefined || !selected.includes(speaker)) {
      setSpeaker(selected[0]);
    }
  }, [selected, speaker]);

  const toggleMember = (id: string): void => {
    setSelectionTouched(true);
    setSelected((current) => toggleId(current, id));
  };
  const togglePack = (id: string): void => setPackIds((current) => toggleId(current, id));
  const toggleCard = (id: string): void => setCardIds((current) => toggleId(current, id));
  const visibleResources = resources.filter((resource) => resource.name.toLowerCase().includes(query.trim().toLowerCase()));

  const formState = { characters: selected, packIds, cardIds, sceneId, premise, userRole, setting, tone };
  const composeSetup = (openingMode: OpeningMode, text: string, speakerId?: string): SessionSetup =>
    composeSessionSetup(formState, { mode: openingMode, text, ...(speakerId === undefined ? {} : { speaker: speakerId }) });
  const submit = async (): Promise<void> => {
    if (createdSessionId !== undefined) {
      router.navigate({ name: 'chat', sessionId: createdSessionId });
      return;
    }
    const sessions = store.repository.sessions;
    if (sessions.createWithSetup === undefined) {
      setError(t('session.create.noStore'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    setOpeningNotice(undefined);
    let notice: string | undefined;
    let modeToCreate: OpeningMode = mode;
    let openingText = mode === 'designated' ? openingInput : '';
    let speakerToCreate = speaker;
    try {
      if (mode === 'auto') {
        setGenerating(true);
        const draft = composeSetup('designated', '', selected[0]);
        const result =
          chat === undefined
            ? { ok: false as const, error: t('session.create.opening.auto.needModel') }
            : await generateOpening({
                settings: store.getState().settings,
                sessionTitle: title.trim(),
                setup: draft,
                cards: openingCardsFor({
                  cards: allCards,
                  ...(cardsMissing ? { legacyCharacters: state.characters } : {}),
                  setup: draft,
                  packs,
                  libraryEnabled,
                }),
                runtime: previewOpeningRuntime(draft),
                ...(assemble === undefined ? {} : { assemble }),
                chat,
              });
        setGenerating(false);
        if (result.ok) {
          modeToCreate = 'designated';
          speakerToCreate = selected[0];
          openingText = result.text;
        } else {
          // 不假装成功：降级为用户开场，原因如实带回本页
          modeToCreate = 'self';
          notice = t('session.create.opening.failed', { message: result.error });
        }
      }
      const setup = composeSetup(modeToCreate, openingText, speakerToCreate);
      const session = await sessions.createWithSetup({
        characterIds: selected,
        setup,
        ...(title.trim() === '' ? {} : { title: title.trim() }),
      });
      await store.actions.refresh();
      if (notice !== undefined) {
        setOpeningNotice(notice);
        setCreatedSessionId(session.id);
        return;
      }
      router.navigate({ name: 'chat', sessionId: session.id });
    } catch (cause) {
      setError(t('session.create.failed', { message: describeError(cause) }));
    } finally {
      setSubmitting(false);
      setGenerating(false);
    }
  };

  if (loading) return <LoadingState label={t('session.create.loading')} />;

  const canSubmit = selected.length > 0 && !submitting && createdSessionId === undefined;
  const autoDisabled = !isModelConfigured(state.settings) || chat === undefined || !chat.available;

  return (
    <div className="form-screen">
      <div className="form">
        {loadError !== undefined && <Banner tone="error">{loadError}</Banner>}
        {error !== undefined && <Banner tone="error">{error}</Banner>}
        {openingNotice !== undefined && <Banner tone="warn">{openingNotice}</Banner>}
        {cardsMissing && <Banner tone="warn">{t('session.create.noCards')}</Banner>}
        {packsMissing && <Banner tone="info">{t('session.create.noPacks')}</Banner>}

        <section className="settings-group">
          <h2 className="settings-group__title">{t('session.create.members')}</h2>
          <p className="field__hint">{t('session.create.members.hint')}</p>
          {members.length === 0 ? (
            <p className="muted">{t('session.create.members.empty')}</p>
          ) : (
            members.map((member) => (
              <label className="switch session-create__member" key={member.id}>
                <input type="checkbox" checked={selected.includes(member.id)} onChange={() => toggleMember(member.id)} />
                <span><span className="session-create__name">{member.name}</span>{member.subtitle !== '' && <span className="session-create__subtitle">{member.subtitle}</span>}</span>
              </label>
            ))
          )}
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t('session.create.basic')}</h2>
          <Field label={t('session.create.titleLabel')} hint={t('session.create.titleHint')}><TextInput value={title} onChange={setTitle} placeholder={t('session.create.titlePlaceholder')} /></Field>
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t('session.create.situation')}</h2>
          <Field label={t('session.create.premise')} hint={t('session.create.premiseHint')}><TextArea value={premise} onChange={setPremise} rows={3} placeholder={t('session.create.premisePlaceholder')} /></Field>
          <Field label={t('session.create.userRole')} hint={t('session.create.userRoleHint')}><TextInput value={userRole} onChange={setUserRole} placeholder={t('session.create.userRolePlaceholder')} /></Field>
          <Field label={t('session.create.setting')} hint={t('session.create.settingHint')}><TextInput value={setting} onChange={setSetting} placeholder={t('session.create.settingPlaceholder')} /></Field>
          <Field label={t('session.create.tone')}>
            <select className="input" value={tone} aria-label={t('session.create.tone')} onChange={(event) => setTone(event.target.value as Tone | '')}>
              <option value="">{t('session.create.tone.unset')}</option>
              {TONES.map((value) => <option key={value} value={value}>{t(`session.create.tone.${value}`)}</option>)}
            </select>
          </Field>
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t('session.create.resources')}</h2>
          <p className="field__hint">{t('session.create.resources.hint')}</p>
          <h3 className="settings-group__title">{t('session.create.packs')}</h3>
          {packs.length === 0 ? (
            <p className="muted">{t('session.create.packs.empty')}</p>
          ) : (
            <div className="session-create__scroll">
              {packs.map((pack) => (
                <label className="switch session-create__member" key={pack.id}>
                  <input type="checkbox" checked={packIds.includes(pack.id)} onChange={() => togglePack(pack.id)} />
                  <span><span className="session-create__name">{pack.name}</span><span className="session-create__subtitle">{t('world.subtitle.pack', { count: pack.card_ids.length })}</span></span>
                </label>
              ))}
            </div>
          )}
          <h3 className="settings-group__title">{t('session.create.cards')}</h3>
          <Field label={t('session.create.cards.search')}><TextInput value={query} onChange={setQuery} placeholder={t('session.create.cards.searchPlaceholder')} /></Field>
          {resources.length === 0 ? (
            <p className="muted">{t('session.create.cards.empty')}</p>
          ) : visibleResources.length === 0 ? (
            <p className="muted">{t('session.create.cards.noMatch')}</p>
          ) : (
            <div className="session-create__scroll">
              {visibleResources.map((resource) => (
                <label className="switch session-create__member" key={resource.id}>
                  <input type="checkbox" checked={cardIds.includes(resource.id)} onChange={() => toggleCard(resource.id)} />
                  <span><span className="session-create__name">{resource.name}</span><span className="session-create__subtitle">{resource.kindLabel}</span></span>
                </label>
              ))}
            </div>
          )}
          <Field label={t('session.create.scene')}>
            <select className="input" value={sceneId} aria-label={t('session.create.scene')} onChange={(event) => setSceneId(event.target.value)}>
              <option value="">{t('session.create.scene.free')}</option>
              {scenes.map((scene) => <option key={scene.meta.id} value={scene.meta.id}>{scene.meta.name}</option>)}
            </select>
          </Field>
          {scenes.length === 0 && <p className="field__hint">{t('session.create.scene.empty')}</p>}
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t('session.create.opening')}</h2>
          <p className="field__hint">{t('session.create.opening.hint')}</p>
          <label className="switch"><input type="radio" name="opening-mode" checked={mode === 'designated'} onChange={() => setMode('designated')} /><span>{t('session.create.opening.designated')}</span></label>
          <p className="field__hint">{t('session.create.opening.designated.hint')}</p>
          {mode === 'designated' &&
            (selected.length === 0 ? (
              <p className="muted">{t('session.create.opening.needMember')}</p>
            ) : (
              <>
                <Field label={t('session.create.opening.speaker')}>
                  <select className="input" value={speaker ?? ''} aria-label={t('session.create.opening.speaker')} onChange={(event) => setSpeaker(event.target.value === '' ? undefined : event.target.value)}>
                    {selected.map((id) => <option key={id} value={id}>{members.find((member) => member.id === id)?.name ?? id}</option>)}
                  </select>
                </Field>
                <Field label={t('session.create.opening.input')} hint={t('session.create.opening.inputHint')}><TextArea value={openingInput} onChange={setOpeningInput} rows={3} placeholder={t('session.create.opening.inputPlaceholder')} /></Field>
              </>
            ))}
          <label className="switch"><input type="radio" name="opening-mode" checked={mode === 'self'} onChange={() => setMode('self')} /><span>{t('session.create.opening.self')}</span></label>
          <p className="field__hint">{t('session.create.opening.self.hint')}</p>
          <label className={`switch${autoDisabled ? ' session-create__disabled' : ''}`}>
            <input type="radio" name="opening-mode" checked={mode === 'auto'} disabled={autoDisabled} onChange={() => setMode('auto')} />
            <span>{t('session.create.opening.auto')}{autoDisabled && <span className="field__hint"> {t('session.create.opening.auto.needModel')}</span>}</span>
          </label>          {!autoDisabled && <p className="field__hint">{t('session.create.opening.auto.hint')}</p>}
        </section>
      </div>
      <div className="actionbar">
        {createdSessionId === undefined ? (
          <Button block disabled={!canSubmit} onClick={() => void submit()}>
            {submitting ? (generating ? t('session.create.opening.generating') : t('session.create.submitBusy')) : t('session.create.submit')}
          </Button>
        ) : (
          <Button block onClick={() => router.navigate({ name: 'chat', sessionId: createdSessionId })}>{t('session.create.enterChat')}</Button>
        )}
      </div>
    </div>
  );
}
