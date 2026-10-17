import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  TONES,
  type CharacterCard,
  type ItemCard,
  type LoreCard,
  type SceneCard,
  type SessionSetup,
  type Tone,
  type WorldPackManifest,
} from '../../../../packages/cards/src/index.ts';
import { describeError } from '../data/error-text.ts';
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

type OpeningChoice = 'designated' | 'self';

function clip(text: string, limit = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

function characterSubtitle(card: CharacterCard): string {
  return clip(card.persona.summary.trim() !== '' ? card.persona.summary : card.identity.background);
}

function resourceKindLabel(t: Translator, card: SceneCard | ItemCard | LoreCard): string {
  if (card.card_type === 'scene') return t(`world.scene.type.${card.type}`);
  if (card.card_type === 'item') return t(`world.item.type.${card.type}`);
  return t(`world.lore.kind.${card.kind}`);
}

/**
 * 会话创建（卡片模型 ADR-0011）：成员 + 这一局处境 + 资源池 + 开场模式 → `SessionSetup`。
 *
 * 旧入口（选角色→选开场白）刻意保留在仓储里；这个屏幕走 `createWithSetup`，
 * 把"这一局"的一次性配置一次写进 `session.setup`，开场消息按模式写（self 不写）。
 * 智能开场（模型生成）尚未实现：选项禁用并注明，不假装能生成。
 */
export function SessionCreateScreen({ store, router, initialCharacterId }: SessionCreateScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [cardsMissing, setCardsMissing] = useState(false);
  const [packsMissing, setPacksMissing] = useState(false);
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
  const [error, setError] = useState<string | undefined>(undefined);

  // 读角色/场景/资源/世界包。卡片缺失时成员退回旧 `characters`（兼容视图）。
  useEffect(() => {
    let alive = true;
    const cards = store.repository.cards;
    if (cards === undefined) {
      setCardsMissing(true);
      setPacksMissing(store.repository.packs === undefined);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(undefined);
    const packsStore = store.repository.packs;
    setPacksMissing(packsStore === undefined);
    const packsPromise = packsStore === undefined ? Promise.resolve([]) : packsStore.list();
    void Promise.all([cards.list(), packsPromise])
      .then(([allCards, loadedPacks]) => {
        if (!alive) return;
        const characterCards = allCards.filter((card): card is CharacterCard => card.card_type === 'character');
        setCardMembers(characterCards.map((card) => ({ id: card.meta.id, name: card.identity.name, subtitle: characterSubtitle(card) })));
        setScenes(allCards.filter((card): card is SceneCard => card.card_type === 'scene'));
        setResources(
          allCards.flatMap((card): ResourceOption[] => {
            if (card.card_type === 'scene' || card.card_type === 'item' || card.card_type === 'lore') {
              return [{ id: card.meta.id, name: card.meta.name, kindLabel: resourceKindLabel(t, card) }];
            }
            return [];
          }),
        );
        setPacks(loadedPacks);
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

  const members = useMemo<MemberOption[]>(() => {
    if (!cardsMissing) return cardMembers;
    return state.characters.map((character) => ({
      id: character.id,
      name: character.name,
      subtitle: clip(character.description || character.personality),
    }));
  }, [cardsMissing, cardMembers, state.characters]);

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
      return;
    }
    if (speaker === undefined || !selected.includes(speaker)) setSpeaker(selected[0]);
  }, [selected, speaker]);

  const toggleMember = (id: string): void => {
    setSelectionTouched(true);
    setSelected((current) => toggleId(current, id));
  };
  const togglePack = (id: string): void => setPackIds((current) => toggleId(current, id));
  const toggleCard = (id: string): void => setCardIds((current) => toggleId(current, id));

  const visibleResources = resources.filter((resource) => resource.name.toLowerCase().includes(query.trim().toLowerCase()));

  const submit = async (): Promise<void> => {
    const sessions = store.repository.sessions;
    if (sessions.createWithSetup === undefined) {
      setError(t('session.create.noStore'));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const setup: SessionSetup = {
        characters: selected,
        ...(packIds.length === 0 && cardIds.length === 0
          ? {}
          : {
              mounts: {
                ...(packIds.length === 0 ? {} : { pack_ids: packIds }),
                ...(cardIds.length === 0 ? {} : { card_ids: cardIds }),
              },
            }),
        ...(sceneId === '' ? {} : { scene_id: sceneId }),
        premise: premise.trim(),
        ...(userRole.trim() === '' ? {} : { user_role: userRole.trim() }),
        ...(setting.trim() === '' ? {} : { setting: setting.trim() }),
        ...(tone === '' ? {} : { tone }),
        opening_mode: mode,
        ...(mode === 'designated'
          ? {
              ...(speaker === undefined ? {} : { opening_speaker: speaker }),
              ...(openingInput.trim() === '' ? {} : { opening_input: openingInput.trim() }),
            }
          : {}),
        origin: 'user',
      };
      const session = await sessions.createWithSetup({
        characterIds: selected,
        setup,
        ...(title.trim() === '' ? {} : { title: title.trim() }),
      });
      await store.actions.refresh();
      router.navigate({ name: 'chat', sessionId: session.id });
    } catch (cause) {
      setError(t('session.create.failed', { message: describeError(cause) }));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingState label={t('session.create.loading')} />;

  const canSubmit = selected.length > 0 && !submitting;

  return (
    <div className="form-screen">
      <div className="form">
        {loadError !== undefined && <Banner tone="error">{loadError}</Banner>}
        {error !== undefined && <Banner tone="error">{error}</Banner>}
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
                <span>
                  <span className="session-create__name">{member.name}</span>
                  {member.subtitle !== '' && <span className="session-create__subtitle">{member.subtitle}</span>}
                </span>
              </label>
            ))
          )}
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t('session.create.basic')}</h2>
          <Field label={t('session.create.titleLabel')} hint={t('session.create.titleHint')}>
            <TextInput value={title} onChange={setTitle} placeholder={t('session.create.titlePlaceholder')} />
          </Field>
        </section>

        <section className="settings-group">
          <h2 className="settings-group__title">{t('session.create.situation')}</h2>
          <Field label={t('session.create.premise')} hint={t('session.create.premiseHint')}>
            <TextArea value={premise} onChange={setPremise} rows={3} placeholder={t('session.create.premisePlaceholder')} />
          </Field>
          <Field label={t('session.create.userRole')} hint={t('session.create.userRoleHint')}>
            <TextInput value={userRole} onChange={setUserRole} placeholder={t('session.create.userRolePlaceholder')} />
          </Field>
          <Field label={t('session.create.setting')} hint={t('session.create.settingHint')}>
            <TextInput value={setting} onChange={setSetting} placeholder={t('session.create.settingPlaceholder')} />
          </Field>
          <Field label={t('session.create.tone')}>
            <select
              className="input"
              value={tone}
              aria-label={t('session.create.tone')}
              onChange={(event) => setTone(event.target.value as Tone | '')}
            >
              <option value="">{t('session.create.tone.unset')}</option>
              {TONES.map((value) => (
                <option key={value} value={value}>
                  {t(`session.create.tone.${value}`)}
                </option>
              ))}
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
                  <span>
                    <span className="session-create__name">{pack.name}</span>
                    <span className="session-create__subtitle">
                      {t('world.subtitle.pack', { count: pack.card_ids.length })}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <h3 className="settings-group__title">{t('session.create.cards')}</h3>
          <Field label={t('session.create.cards.search')}>
            <TextInput value={query} onChange={setQuery} placeholder={t('session.create.cards.searchPlaceholder')} />
          </Field>
          {resources.length === 0 ? (
            <p className="muted">{t('session.create.cards.empty')}</p>
          ) : visibleResources.length === 0 ? (
            <p className="muted">{t('session.create.cards.noMatch')}</p>
          ) : (
            <div className="session-create__scroll">
              {visibleResources.map((resource) => (
                <label className="switch session-create__member" key={resource.id}>
                  <input type="checkbox" checked={cardIds.includes(resource.id)} onChange={() => toggleCard(resource.id)} />
                  <span>
                    <span className="session-create__name">{resource.name}</span>
                    <span className="session-create__subtitle">{resource.kindLabel}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <Field label={t('session.create.scene')}>
            <select className="input" value={sceneId} aria-label={t('session.create.scene')} onChange={(event) => setSceneId(event.target.value)}>
              <option value="">{t('session.create.scene.free')}</option>
              {scenes.map((scene) => (
                <option key={scene.meta.id} value={scene.meta.id}>
                  {scene.meta.name}
                </option>
              ))}
            </select>
          </Field>
          {scenes.length === 0 && <p className="field__hint">{t('session.create.scene.empty')}</p>}
        </section>
        <section className="settings-group">
          <h2 className="settings-group__title">{t('session.create.opening')}</h2>
          <p className="field__hint">{t('session.create.opening.hint')}</p>
          <label className="switch">
            <input type="radio" name="opening-mode" checked={mode === 'designated'} onChange={() => setMode('designated')} />
            <span>{t('session.create.opening.designated')}</span>
          </label>
          <p className="field__hint">{t('session.create.opening.designated.hint')}</p>
          {mode === 'designated' &&
            (selected.length === 0 ? (
              <p className="muted">{t('session.create.opening.needMember')}</p>
            ) : (
              <>
                <Field label={t('session.create.opening.speaker')}>
                  <select
                    className="input"
                    value={speaker ?? ''}
                    aria-label={t('session.create.opening.speaker')}
                    onChange={(event) => setSpeaker(event.target.value === '' ? undefined : event.target.value)}
                  >
                    {selected.map((id) => (
                      <option key={id} value={id}>
                        {members.find((member) => member.id === id)?.name ?? id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('session.create.opening.input')} hint={t('session.create.opening.inputHint')}>
                  <TextArea
                    value={openingInput}
                    onChange={setOpeningInput}
                    rows={3}
                    placeholder={t('session.create.opening.inputPlaceholder')}
                  />
                </Field>
              </>
            ))}
          <label className="switch">
            <input type="radio" name="opening-mode" checked={mode === 'self'} onChange={() => setMode('self')} />
            <span>{t('session.create.opening.self')}</span>
          </label>
          <p className="field__hint">{t('session.create.opening.self.hint')}</p>
          <label className="switch session-create__disabled">
            <input type="radio" name="opening-mode" disabled />
            <span>
              {t('session.create.opening.auto')} <span className="field__hint">{t('session.create.opening.auto.unavailable')}</span>
            </span>
          </label>
        </section>
      </div>
      <div className="actionbar">
        <Button block disabled={!canSubmit} onClick={() => void submit()}>
          {submitting ? t('session.create.submitBusy') : t('session.create.submit')}
        </Button>
      </div>
    </div>
  );
}
