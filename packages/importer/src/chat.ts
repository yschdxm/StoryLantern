import { asString, asStringArray, ImportError, isRecord, type ImportedChat } from './types.ts';

/**
 * 聊天记录导入：SillyTavern 的 JSONL（首行 header，其余每行一条消息）。
 *
 * 只映射 v0.1 真正用得上的东西：谁说的（user/assistant/system）、说了什么、什么时候说的。
 * `swipes`（每次生成的候选回复）与 `extra` 写进 notes 提示用户——不假装支持。
 */
export function parseChatText(text: string, source: string): ImportedChat {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) throw new ImportError('empty-chat', '聊天记录是空的');

  let header: Record<string, unknown> = {};
  let startIndex = 0;
  const first = tryJson(lines[0] ?? '');
  if (isRecord(first) && !('mes' in first) && ('user_name' in first || 'character_name' in first || 'create_date' in first)) {
    header = first;
    startIndex = 1;
  }

  const messages: ImportedChat['messages'] = [];
  let swipes = 0;
  let broken = 0;

  for (let index = startIndex; index < lines.length; index += 1) {
    const parsed = tryJson(lines[index] ?? '');
    if (!isRecord(parsed)) {
      // 单行键坏了不该丢掉整份记录：跳过并计数，最后如实告诉用户
      if (lines[index]?.trim() !== '') broken += 1;
      continue;
    }
    const content = asString(parsed['mes'] ?? parsed['content']);
    if (content.trim() === '') continue;
    const isUser = parsed['is_user'] === true || asString(parsed['role']) === 'user';
    const isSystem = parsed['is_system'] === true || asString(parsed['role']) === 'system';
    const sendDate = Number(parsed['send_date'] ?? parsed['createdAt'] ?? 0);
    if (asStringArray(parsed['swipes']).length > 1) swipes += 1;
    messages.push({
      role: isSystem ? 'system' : isUser ? 'user' : 'assistant',
      content,
      createdAt: Number.isFinite(sendDate) && sendDate > 0 ? sendDate : 0,
    });
  }

  if (messages.length === 0) throw new ImportError('empty-chat', '聊天记录里没有可导入的消息');

  const notes: string[] = [];
  if (swipes > 0) notes.push(`${swipes} 条消息有多个候选回复，只导入选中的那一条`);
  if (broken > 0) notes.push(`${broken} 行无法解析，已跳过`);

  const characterName = asString(header['character_name']) || dominantAssistantName(text) || '导入的角色';
  const userName = asString(header['user_name']);
  const title = userName === '' ? `${characterName} 的历史记录` : `${userName} 与 ${characterName}`;

  return { kind: 'chat', source, characterName, title, messages, notes };
}

function tryJson(line: string): unknown {
  if (line === '') return undefined;
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** header 缺 character_name 时，用出现最多的非用户 name 兜底。 */
function dominantAssistantName(text: string): string {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const parsed = tryJson(line.trim());
    if (!isRecord(parsed) || parsed['is_user'] === true) continue;
    const name = asString(parsed['name']);
    if (name === '') continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}
