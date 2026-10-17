/**
 * 卡片文档的判别联合与类型守卫（单独成文件，避免 `index.ts` 与 `activation.ts` 互相 import 成环）。
 */

import type { CardType } from './types-base.ts';
import type { CharacterCard } from './types-character.ts';
import type { ItemCard, LoreCard, SceneCard } from './types-world.ts';

export type CardDocument = CharacterCard | SceneCard | ItemCard | LoreCard;

export type CardOf<T extends CardType> = T extends 'character'
  ? CharacterCard
  : T extends 'scene'
    ? SceneCard
    : T extends 'item'
      ? ItemCard
      : T extends 'lore'
        ? LoreCard
        : never;

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
