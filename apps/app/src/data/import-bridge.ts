import type { ImportedCharacter, ImportedChat, ImportedLorebook } from '../../../../packages/importer/src/index.ts';
import type { Character, CharacterDraft, LoreEntryDraft, LorebookDraft, MessageRole } from './types.ts';

/**
 * 导入结果 → 应用模型的映射（纯函数，可测）。
 *
 * 界面只负责"选文件、显示结果、调用这里的计划再落库"；
 * 映射一旦写进组件就没法测了，而这里恰恰是最需要测的地方（字段多、易漏）。
 */

/** 角色卡里的内嵌世界书**不再**塞进场景字段，而是变成一本真正绑定了该角色的世界书。 */
export function characterDraftFrom(card: ImportedCharacter): CharacterDraft {
  return {
    name: card.name.slice(0, 60),
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    firstMessage: card.firstMessage,
    exampleDialogue: card.exampleDialogue,
    systemPrompt: card.systemPrompt,
    alternateGreetings: card.alternateGreetings,
  };
}

/** 内嵌世界书 → 世界书草稿（绑定到刚导入的角色）。 */
export function lorebookDraftFrom(lorebook: ImportedLorebook, characterId: string): LorebookDraft {
  return { name: lorebook.name.slice(0, 60), description: lorebook.description, characterIds: [characterId] };
}

/** 内嵌世界书条目 → 条目草稿（字段一一对应，不需要猜）。 */
export function loreEntryDraftsFrom(lorebookId: string, lorebook: ImportedLorebook): LoreEntryDraft[] {
  return lorebook.entries
    .filter((entry) => entry.content.trim() !== '')
    .map((entry, index) => ({
      lorebookId,
      keys: entry.keys,
      secondaryKeys: entry.secondaryKeys,
      content: entry.content.trim(),
      enabled: entry.enabled,
      // 卡片里的顺序就是用户排的顺序：按导入顺序给 order，保证注入顺序一致
      order: index * 10,
      constant: entry.constant,
    }));
}

/**
 * 过渡期的兜底：把世界书并入角色设定。
 *
 * M1 之前没有独立的世界书存储，那时只能把内嵌世界书写进场景字段；现在导入了真正的书，
 * 因此这个函数**只留给"旧数据迁移"用**（`withLorebook` 不再参与新导入）。
 */
export function withLorebook(scenario: string, lorebook: ImportedLorebook | undefined): string {
  if (lorebook === undefined) return scenario;
  const lines = lorebook.entries
    .filter((entry) => entry.content.trim() !== '')
    .map((entry) => {
      const keys = entry.keys.length > 0 ? `（触发：${entry.keys.join('、')}）` : '';
      return `- ${entry.content.trim()}${keys}`;
    });
  if (lines.length === 0) return scenario;
  return `${scenario}\n\n【参考设定：${lorebook.name}】\n${lines.join('\n')}`.trim();
}

export interface ChatImportPlan {
  /** 聊天记录归属的角色名（找不到就按这个名字新建一个）。 */
  characterName: string;
  /** 已有同名角色时直接用，避免同一角色被导入成两份。 */
  existingCharacter?: Character;
  title: string;
  messages: Array<{ role: MessageRole; content: string; candidates: string[]; createdAt?: number }>;
}

export function chatImportPlan(chat: ImportedChat, characters: Character[]): ChatImportPlan {
  const existing = characters.find((character) => character.name === chat.characterName);
  return {
    characterName: chat.characterName,
    ...(existing === undefined ? {} : { existingCharacter: existing }),
    title: chat.title,
    messages: chat.messages.map((message) => ({
      role: message.role,
      content: message.content,
      // swipes：当前那条是正文，其余作为候选（导入时一并落库）
      candidates: [...(message.candidates ?? [])],
      // 0 表示原始文件没给时间：交给仓储按"现在"处理，而不是塞一个 1970 年
      ...(message.createdAt > 0 ? { createdAt: message.createdAt } : {}),
    })),
  };
}
