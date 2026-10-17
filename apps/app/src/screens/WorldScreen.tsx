import { useEffect, useState, type ReactNode } from 'react';
import { describeError } from '../data/error-text.ts';
import { useT } from '../i18n/context.tsx';
import type { Translator } from '../i18n/locale.ts';
import type { AppStore } from '../app/state.ts';
import type { Router, WorldKind } from '../app/router.ts';
import type { CardDocument, WorldPackManifest } from '../../../../packages/cards/src/index.ts';
import { Banner, Button, EmptyState, Icon, LoadingState, Sheet, SheetItem } from '../ui/components.tsx';
import { SettingsRow } from '../ui/SettingsRow.tsx';

export interface WorldScreenProps {
  store: AppStore;
  router: Router;
}

type WorldFilter = 'all' | WorldKind | 'pack';

const FILTERS: readonly WorldFilter[] = ['all', 'scene', 'item', 'lore', 'pack'];

/** 卡片类型 → 三类世界资源之一；角色卡不属于世界资源列表。 */
function worldKindOf(card: CardDocument): WorldKind | undefined {
  if (card.card_type === 'scene') return 'scene';
  if (card.card_type === 'item') return 'item';
  if (card.card_type === 'lore') return 'lore';
  return undefined;
}

/** 列表行的副标题 = 当前值（类型 + 出口/触发词数）+ 启用状态。 */
function subtitleOf(card: CardDocument, enabled: boolean, t: Translator): string {
  const status = enabled ? t('world.enabled') : t('world.disabled');
  if (card.card_type === 'scene') {
    return [t(`world.scene.type.${card.type}`), t('world.subtitle.connections', { count: card.connections?.length ?? 0 }), status].join(' · ');
  }
  if (card.card_type === 'item') {
    const parts = [t(`world.item.type.${card.type}`)];
    if (card.rarity !== undefined) parts.push(t(`world.item.rarity.${card.rarity}`));
    parts.push(status);
    return parts.join(' · ');
  }
  if (card.card_type === 'lore') {
    return [t(`world.lore.kind.${card.kind}`), t('world.subtitle.keys', { count: card.keys.length }), status].join(' · ');
  }
  return status;
}

/**
 * 世界资源 L1 列表：场景簿 / 物品图鉴 / 典籍 + 世界包。
 *
 * 数据直接读 `repository.cards` 与 `repository.packs`（可选）。没有卡片模型时
 * **诚实提示**而不是假装空列表——与角色编辑器一致。
 */
export function WorldScreen({ store, router }: WorldScreenProps): ReactNode {
  const t = useT();
  const initial = router.current();
  const [filter, setFilter] = useState<WorldFilter>(initial.name === 'world' && initial.kind !== undefined ? initial.kind : 'all');
  const [cards, setCards] = useState<CardDocument[]>([]);
  const [packs, setPacks] = useState<WorldPackManifest[]>([]);
  const [enabled, setEnabled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [packsAvailable, setPacksAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [packError, setPackError] = useState<string | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [packId, setPackId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    const cardsStore = store.repository.cards;
    if (cardsStore === undefined) {
      setError(t('world.noCards'));
      setCards([]);
      setPacks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(undefined);
    setPackError(undefined);
    const packsStore = store.repository.packs;
    setPacksAvailable(packsStore !== undefined);
    // 世界包失败不该拖垮三类卡片的列表：单独如实提示，卡片照常显示
    const packsPromise =
      packsStore === undefined
        ? Promise.resolve<WorldPackManifest[]>([])
        : packsStore.list().catch((cause: unknown) => {
            if (alive) setPackError(describeError(cause));
            return [];
          });
    void Promise.all([cardsStore.list(), cardsStore.library(), packsPromise])
      .then(([loadedCards, library, loadedPacks]) => {
        if (!alive) return;
        setCards(loadedCards.filter((card) => worldKindOf(card) !== undefined));
        setPacks(loadedPacks);
        setEnabled(new Map(library.map((entry) => [entry.id, entry.enabled] as const)));
      })
      .catch((cause: unknown) => {
        if (alive) setError(describeError(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [store, reload, t]);

  const filteredCards = cards.filter((card) => {
    if (filter === 'all') return true;
    if (filter === 'pack') return false;
    return card.card_type === filter;
  });
  const filteredPacks = filter === 'all' || filter === 'pack' ? packs : [];
  const total = filteredCards.length + filteredPacks.length;
  const hasAny = cards.length > 0 || packs.length > 0;
  const pack = packs.find((item) => item.id === packId);
  const cardNames = new Map(cards.map((card) => [card.meta.id, card.meta.name] as const));

  const openNew = (kind: WorldKind): void => {
    setNewOpen(false);
    router.navigate({ name: 'worldCard', kind, cardId: 'new' });
  };

  if (loading) return <LoadingState label={t('world.loading')} />;

  return (
    <>
      {error !== undefined && (
        <Banner
          tone="error"
          action={
            <Button variant="ghost" onClick={() => setReload((value) => value + 1)}>
              {t('common.retry')}
            </Button>
          }
        >
          {error}
        </Banner>
      )}
      {!packsAvailable && error === undefined && <Banner tone="info">{t('world.noPacks')}</Banner>}
      {packError !== undefined && <Banner tone="warn">{packError}</Banner>}

      <div className="chips world-filters">
        {FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            className={`chip${filter === value ? ' chip--on' : ''}`}
            aria-pressed={filter === value}
            data-testid={`world-filter-${value}`}
            onClick={() => setFilter(value)}
          >
            {t(value === 'all' ? 'world.filter.all' : `world.filter.${value}`)}
          </button>
        ))}
      </div>

      {total === 0 ? (
        <div className="settings-group" data-testid="world-list">
          <EmptyState
            icon="book"
            title={hasAny ? t('world.empty.filtered') : t('world.empty.title')}
            hint={t('world.empty.hint')}
          />
        </div>
      ) : (
        <div className="settings-group" data-testid="world-list">
          {filteredCards.map((card) => {
            const kind = worldKindOf(card);
            if (kind === undefined) return null;
            return (
              <SettingsRow
                key={`card-${card.meta.id}`}
                label={card.meta.name}
                value={subtitleOf(card, enabled.get(card.meta.id) ?? true, t)}
                onPress={() => router.navigate({ name: 'worldCard', kind, cardId: card.meta.id })}
                testId={`world-card-${card.meta.id}`}
              />
            );
          })}
          {filteredPacks.map((item) => (
            <SettingsRow
              key={`pack-${item.id}`}
              label={item.name}
              value={t('world.subtitle.pack', { count: item.card_ids.length })}
              onPress={() => setPackId(item.id)}
              testId={`world-pack-${item.id}`}
            />
          ))}
        </div>
      )}

      {/* 一屏一个主按钮：空态也用这个 FAB（EmptyState 不再放第二个主按钮） */}
      <button type="button" className="fab" aria-label={t('world.new')} onClick={() => setNewOpen(true)}>
        <Icon name="plus" size={26} />
      </button>

      <Sheet open={newOpen} title={t('world.new')} onClose={() => setNewOpen(false)}>
        <SheetItem label={t('world.new.scene')} onClick={() => openNew('scene')} />
        <SheetItem label={t('world.new.item')} onClick={() => openNew('item')} />
        <SheetItem label={t('world.new.lore')} onClick={() => openNew('lore')} />
      </Sheet>

      <Sheet open={pack !== undefined} title={pack?.name ?? t('world.pack.title')} onClose={() => setPackId(undefined)}>
        {pack !== undefined && pack.card_ids.length === 0 && <p className="muted">{t('world.pack.empty')}</p>}
        {pack?.card_ids.map((id) => (
          <SheetItem
            key={id}
            icon="book"
            label={cardNames.get(id) ?? t('world.pack.unknownCard', { id })}
            disabled
            onClick={() => undefined}
          />
        ))}
      </Sheet>
    </>
  );
}
