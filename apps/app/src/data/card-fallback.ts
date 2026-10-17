/**
 * 过渡期的"卡片兜底投影"：把**旧域对象**（`Character` / `Lorebook` / `LoreEntry`）映射成卡片文档。
 *
 * 为什么需要它：
 *  - 旧编辑器仍写旧 op（`character.upsert` / `lore.entry.upsert`），而新提示词装配只读卡片；
 *  - 迁移（`migrate-cards.ts`）只在启动时跑，所以"刚改完还没重启"的那一段必须能兜住；
 *  - 浏览器里的最小实现、测试夹具、e2e 也可能只有旧数据。
 *
 * 这些投影是**只读兜底**：真正的权威来源是 `cards`（迁移 + 新编辑器写入）。
 * 字段映射与迁移保持一致（同一套规则两处写会漂移，但是过渡期的一次性代价；
 * 迁移落地后这个文件随旧编辑器一起删）。
 */

import type { CardDocument, CharacterCard, LoreCard, SessionRuntime, SessionSetup } from '../../../../packages/cards/src/index.ts';
import type { Character, Lorebook, Session } from './types.ts';

/** 空运行时：没有补丁的会话就是这个状态。 */
export function emptyRuntime(): SessionRuntime {
  return { variables: { session: {} }, items: {}, scene_state: {} };
}

function traitsOf(personality: string): string[] {
  return personality
    .split(/[\n、,，]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** 旧角色 → 角色卡（与迁移同规则；差异是这里没有 HLC，只有内容）。 */
export function characterCardOfLegacy(character: Character): CharacterCard {
  const personality = character.personality.trim();
  const firstLine = personality.split('\n')[0]?.trim() ?? '';
  const examples =
    character.exampleDialogue.trim() === ''
      ? []
      : [
          {
            id: `${character.id}-example-1`,
            tags: ['legacy'],
            context: '从旧数据导入的示例对话（原文保留，未拆成多轮）',
            messages: [{ role: 'assistant' as const, content: character.exampleDialogue.trim() }],
          },
        ];
  return {
    card_type: 'character',
    meta: {
      id: character.id,
      schema: 'rolecard/v1',
      name: character.name,
      version: '1.0.0',
      language: 'zh-CN',
      rating: 'general',
      description: character.description,
    },
    identity: { name: character.name, background: character.description },
    persona: {
      summary: firstLine,
      traits: traitsOf(personality),
      knowledge_boundary: '',
      ability_boundary: '',
    },
    speech: { style: '' },
    ...(examples.length === 0 ? {} : { examples }),
    ...(character.systemPrompt.trim() === ''
      ? {}
      : { prompts: { system_extra: character.systemPrompt } }),
  };
}

/** 旧世界书 → 若干典籍卡（每条目一张，与迁移一致）。 */
export function loreCardsOfLegacy(book: Lorebook): LoreCard[] {
  return book.entries.map((entry) => ({
    card_type: 'lore',
    meta: {
      id: entry.id,
      schema: 'lore/v1',
      // 与迁移规则一致：名字优先第一个触发词（旧 comment 常是 provenance 文本）
      name: entry.keys[0] ?? (entry.comment.trim() !== '' ? entry.comment.trim() : '条目'),
      version: '1.0.0',
      language: 'zh-CN',
      rating: 'general',
      description: entry.content.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '',
      ...(entry.enabled ? {} : { tags: ['legacy-disabled'] }),
    },
    kind: 'other',
    content: entry.content,
    keys: entry.keys,
    ...(entry.secondaryKeys.length === 0 ? {} : { secondary_keys: entry.secondaryKeys }),
    trigger: {
      constant: entry.constant,
      priority: entry.order,
      recursive: entry.recursive,
      ...(entry.depth === 0 ? {} : { depth: entry.depth }),
    },
  }));
}

/** 合并卡片集合：卡片源优先（同 id 不重复）。 */
export function mergeCards(primary: readonly CardDocument[], fallback: readonly CardDocument[]): CardDocument[] {
  const seen = new Set(primary.map((card) => card.meta.id));
  const out: CardDocument[] = [...primary];
  for (const card of fallback) {
    if (seen.has(card.meta.id)) continue;
    seen.add(card.meta.id);
    out.push(card);
  }
  return out;
}

/** 旧会话 → 开局配置（没有角色就不生成：`characters` 语义是 ≥1）。 */
export function setupOfLegacySession(session: Session, premise = ''): SessionSetup | undefined {
  if (session.characterId === '') return undefined;
  return {
    characters: [session.characterId],
    premise,
    opening_mode: 'designated',
    opening_speaker: session.characterId,
    origin: 'card',
  };
}

/** 空开局配置：用于"还没有 setup"的计算（例如激活判定），不代表真实会话。 */
export function emptySetup(): SessionSetup {
  return { characters: [], premise: '', opening_mode: 'self', origin: 'card' };
}
