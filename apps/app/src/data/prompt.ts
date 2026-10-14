import { scanLore, type ScanBook, type ScoredEntry } from '../../../../packages/lore/src/index.ts';
import { SETTING_KEYS, type MessageRole, type Lorebook } from './types.ts';

/**
 * 组装模型请求。
 *
 * 为什么放在前端：M1 之后"上下文"的唯一来源是 op 日志（角色卡 + 历史消息都在前端物化状态里），
 * 宿主不该再存一份。这样也只有一个地方在决定"给模型看什么"——可解释性从这里开始。
 *
 * 世界书也在这里参与：先用 `packages/lore` 扫一遍关键词，命中的设定作为【相关设定】追加进系统提示。
 * 命中的具体条目会随请求一起返回，界面可以如实告诉用户"这次注入了哪几条"。
 */

export interface ChatPromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  systemPrompt: string;
  messages: ChatPromptMessage[];
  /** 本次实际注入的世界书条目（空数组 = 没命中任何设定）。 */
  lore: ScoredEntry[];
}

export interface PromptCharacter {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  exampleDialogue: string;
}

export interface PromptHistoryItem {
  role: MessageRole;
  content: string;
  status?: 'done' | 'streaming' | 'error';
}

export interface BuildPromptOptions {
  settings: Record<string, string>;
  character?: PromptCharacter;
  history: readonly PromptHistoryItem[];
  /** 该角色可用的世界书（调用方已按角色筛过；全局书也算）。 */
  lorebooks?: readonly Lorebook[];
  /** 世界书预算（字符）；不传用扫描器默认值。 */
  loreBudgetChars?: number;
}

export function buildChatRequest(options: BuildPromptOptions): ChatRequest {
  const custom = (options.settings[SETTING_KEYS.systemPrompt] ?? '').trim();

  const messages: ChatPromptMessage[] = [];
  for (const item of options.history) {
    // 空内容（还没生成出来）与失败的消息不进上下文
    if (item.content.trim() === '' || item.status === 'error') continue;
    messages.push({ role: item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : 'system', content: item.content });
  }

  // 世界书扫描：只看能进上下文的消息（失败/空的不参与匹配），深度窗口由扫描器处理
  const lore = scanLore({
    books: (options.lorebooks ?? []) as readonly ScanBook[],
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    ...(options.loreBudgetChars === undefined ? {} : { budgetChars: options.loreBudgetChars }),
  });

  const loreBlock =
    lore.matched.length === 0
      ? ''
      : `【相关设定】\n${lore.matched.map((entry) => entry.content.trim()).join('\n')}`;

  const systemPrompt = [custom, characterPrompt(options.character), loreBlock].filter((part) => part !== '').join('\n');
  return { systemPrompt, messages, lore: lore.matched };
}

/** 角色卡 → 系统提示。字段为空就不写那一段，避免给模型塞空标题。 */
export function characterPrompt(character: PromptCharacter | undefined): string {
  if (character === undefined) return '';
  const parts = [`你要扮演「${character.name}」。`];
  if (character.description.trim() !== '') parts.push(`【设定】${character.description.trim()}`);
  if (character.personality.trim() !== '') parts.push(`【性格】${character.personality.trim()}`);
  if (character.scenario.trim() !== '') parts.push(`【场景】${character.scenario.trim()}`);
  if (character.exampleDialogue.trim() !== '') parts.push(`【对话示例】\n${character.exampleDialogue.trim()}`);
  parts.push('直接以角色身份说话，不要解释你是 AI，也不要用旁白复述设定。');
  return parts.join('\n');
}
