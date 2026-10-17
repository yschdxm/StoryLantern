/**
 * 会话工作区：一次装配所需的"本会话相关数据"快照（开局配置 / 卡片 / 运行时）。
 *
 * 为什么单独一层：聊天页只需要"这个会话的设定视图"，不应该知道仓储分了几个 store、
 * 也不应该自己决定"新模型没有时怎么退回旧数据"。兜底规则集中在 `card-fallback.ts`。
 *
 * 激活（"哪张卡参与"）也在这里算：资源池 = 会话挂载的世界包 ∪ 直接挂载的单卡
 * （不填 = 全库），库级启停与按类型自动激活在 `packages/cards/src/activation.ts` 里。
 */

import {
  partitionCards,
  type ActivationEntry,
  type CardDocument,
  type SessionRuntime,
  type SessionSetup,
} from '../../../../packages/cards/src/index.ts';
import type { Repository } from '../data/repository.ts';
import {
  characterCardOfLegacy,
  emptyRuntime,
  emptySetup,
  loreCardsOfLegacy,
  mergeCards,
  setupOfLegacySession,
} from '../data/card-fallback.ts';
import type { AppState } from './state.ts';

export interface WorkspaceSnapshot {
  /** 开局配置；旧会话在迁移前可能没有（用旧字段合成）。 */
  setup?: SessionSetup;
  /** 参与本会话的卡片（已按库启停 / 资源池 / 类型激活过滤）。 */
  cards: CardDocument[];
  /** 没参与的卡片及原因（给请求面板，避免"它为什么不生效"说不清）。 */
  inactive: ActivationEntry[];
  runtime: SessionRuntime;
}

/** 由"挂载的包 + 单卡"算出资源池；没有挂载配置时返回 undefined（= 全库可用）。 */
export function mountedIdsOf(
  setup: SessionSetup | undefined,
  packCardIds: ReadonlyMap<string, readonly string[]>,
): Set<string> | undefined {
  if (setup === undefined) return undefined;
  const mounts = setup.mounts ?? (setup.world_pack_ids === undefined ? undefined : { pack_ids: setup.world_pack_ids });
  if (mounts === undefined) return undefined;
  const ids = new Set<string>(mounts.card_ids ?? []);
  for (const packId of mounts.pack_ids ?? []) {
    for (const cardId of packCardIds.get(packId) ?? []) ids.add(cardId);
  }
  return ids;
}

export async function loadWorkspace(
  repository: Repository,
  state: AppState,
  sessionId: string,
): Promise<WorkspaceSnapshot> {
  const session = state.sessions.find((item) => item.id === sessionId);
  const cards = repository.cards === undefined ? [] : await repository.cards.list().catch(() => []);
  const setup = repository.setups === undefined ? undefined : await repository.setups.get(sessionId).catch(() => undefined);
  const runtime = repository.runtime === undefined ? undefined : await repository.runtime.get(sessionId).catch(() => undefined);
  const packs = repository.packs === undefined ? [] : await repository.packs.list().catch(() => []);
  const library = repository.cards === undefined ? [] : await repository.cards.library().catch(() => []);

  const fallbackCards: CardDocument[] = [
    ...state.characters.map(characterCardOfLegacy),
    ...state.lorebooks.flatMap(loreCardsOfLegacy),
  ];
  const resolvedSetup = setup ?? (session === undefined ? undefined : setupOfLegacySession(session));
  const resolvedRuntime = runtime ?? emptyRuntime();
  const packCardIds = new Map(packs.map((pack) => [pack.id, pack.card_ids] as const));
  const mounted = mountedIdsOf(resolvedSetup, packCardIds);
  const enabled = new Map(library.map((entry) => [entry.id, entry.enabled] as const));
  const partitioned = partitionCards(mergeCards(cards, fallbackCards), {
    setup: resolvedSetup ?? emptySetup(),
    runtime: resolvedRuntime,
    ...(mounted === undefined ? {} : { mounted }),
    isLibraryEnabled: (cardId) => enabled.get(cardId) ?? true,
  });

  return {
    ...(resolvedSetup === undefined ? {} : { setup: resolvedSetup }),
    cards: partitioned.active,
    inactive: partitioned.inactive,
    runtime: resolvedRuntime,
  };
}
