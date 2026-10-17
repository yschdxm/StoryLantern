/**
 * 会话工作区：一次装配所需的"本会话相关数据"快照（开局配置 / 卡片 / 运行时）。
 *
 * 为什么单独一层：聊天页只需要"这个会话的设定视图"，不应该知道仓储分了几个 store、
 * 也不应该自己决定"新模型没有时怎么退回旧数据"。兜底规则集中在 `card-fallback.ts`。
 */

import type { CardDocument, SessionRuntime, SessionSetup } from '../../../../packages/cards/src/index.ts';
import type { Repository } from '../data/repository.ts';
import { characterCardOfLegacy, emptyRuntime, loreCardsOfLegacy, mergeCards, setupOfLegacySession } from '../data/card-fallback.ts';
import type { AppState } from './state.ts';

export interface WorkspaceSnapshot {
  /** 开局配置；旧会话在迁移前可能没有（用旧字段合成）。 */
  setup?: SessionSetup;
  /** 本会话可用卡片（卡片源 + 旧数据兜底投影；同 id 以卡片为准）。 */
  cards: CardDocument[];
  runtime: SessionRuntime;
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

  const fallbackCards: CardDocument[] = [
    ...state.characters.map(characterCardOfLegacy),
    ...state.lorebooks.flatMap(loreCardsOfLegacy),
  ];
  const resolvedSetup = setup ?? (session === undefined ? undefined : setupOfLegacySession(session));
  return {
    ...(resolvedSetup === undefined ? {} : { setup: resolvedSetup }),
    cards: mergeCards(cards, fallbackCards),
    runtime: runtime ?? emptyRuntime(),
  };
}
