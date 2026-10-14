import type { ImportedCharacter, ImportedChat, ImportedLorebook } from '../../../../packages/importer/src/index.ts';
import type { Character, CharacterDraft, MessageRole } from './types.ts';

/**
 * 导入结果 → 应用模型的映射（纯函数，可测）。
 *
 * 界面只负责"选文件、显示结果、调用这里的计划再落库"；
 * 映射一旦写进组件就没法测了，而这里恰恰是最需要测的地方（字段多、易漏）。
 */

export function characterDraftFrom(card: ImportedCharacter): CharacterDraft {
  return {
    name: card.name.slice(0, 60),
    description: card.description,
    personality: card.personality,
    scenario: withLorebook(card.scenario, card.lorebook),
    firstMessage: card.firstMessage,
    exampleDialogue: card.exampleDialogue,
  };
}

/**
 * 世界书并入角色设定。v0.1 没有独立的世界书存储，但"导入后信息不见了"是不能接受的，
 * 所以用一段可读的「参考设定」把它存进场景字段——将来有了正式存储可以再迁移出来。
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
  messages: Array<{ role: MessageRole; content: string; createdAt?: number }>;
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
      // 0 表示原始文件没给时间：交给仓储按"现在"处理，而不是塞一个 1970 年
      ...(message.createdAt > 0 ? { createdAt: message.createdAt } : {}),
    })),
  };
}
