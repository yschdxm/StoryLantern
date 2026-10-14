import { SETTING_KEYS, type MessageRole } from './types.ts';

/**
 * 组装模型请求。
 *
 * 为什么放在前端：M1 之后"上下文"的唯一来源是 op 日志（角色卡 + 历史消息都在前端物化状态里），
 * 宿主不该再存一份。这样也只有一个地方在决定"给模型看什么"——可解释性从这里开始。
 */

export interface ChatPromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatRequest {
  systemPrompt: string;
  messages: ChatPromptMessage[];
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
}

export function buildChatRequest(options: BuildPromptOptions): ChatRequest {
  const custom = (options.settings[SETTING_KEYS.systemPrompt] ?? '').trim();
  const systemPrompt = [custom, characterPrompt(options.character)].filter((part) => part !== '').join('\n');

  const messages: ChatPromptMessage[] = [];
  for (const item of options.history) {
    // 空内容（还没生成出来）与失败的消息不进上下文
    if (item.content.trim() === '' || item.status === 'error') continue;
    messages.push({ role: item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : 'system', content: item.content });
  }
  return { systemPrompt, messages };
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
