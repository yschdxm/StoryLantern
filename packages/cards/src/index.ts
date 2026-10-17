/**
 * 卡片模型（`@storylantern/cards`）：四类资源 + 会话层 + 世界包。
 *
 * 这里只有**类型与纯函数**，没有 I/O、没有 React、没有 op 日志依赖 ——
 * 因此它能在 Node 单测里穷举，也能被界面、宿主、导入器共用。
 */

export * from './types-base.ts';
export * from './types-enums.ts';
export * from './types-character.ts';
export * from './types-world.ts';
export * from './types-session.ts';
export * from './validate.ts';
export * from './brief.ts';

import type { CardType } from './types-base.ts';
import type { CharacterCard } from './types-character.ts';
import type { ItemCard, LoreCard, SceneCard, WorldPackManifest } from './types-world.ts';

/** 四类卡片文档的判别联合。 */
export type CardDocument = CharacterCard | SceneCard | ItemCard | LoreCard;

/** 按类型取对应卡片。 */
export type CardOf<T extends CardType> = T extends 'character'
  ? CharacterCard
  : T extends 'scene'
    ? SceneCard
    : T extends 'item'
      ? ItemCard
      : T extends 'lore'
        ? LoreCard
        : never;

export type { WorldPackManifest };

/** 类型守卫：把 `CardDocument` 收窄成具体一类。 */
export function isCharacterCard(card: CardDocument): card is CharacterCard {
  return card.card_type === 'character';
}

export function isSceneCard(card: CardDocument): card is SceneCard {
  return card.card_type === 'scene';
}

export function isItemCard(card: CardDocument): card is ItemCard {
  return card.card_type === 'item';
}

export function isLoreCard(card: CardDocument): card is LoreCard {
  return card.card_type === 'lore';
}
