import {
  isRecord,
  type ImportedCharacter,
  type ImportedChat,
  type ImportedLorebook,
  type ImportedLorebookEntry,
  type ImportedLorebookFile,
} from './types.ts';

/**
 * 导出：把领域对象**写回同格式**，并保留原始文件里的未知字段。
 *
 * 为什么值得单独一块：M1 的退出判据之一是"导出同格式无损回写（未知字段保留）"。
 * 只有导入器时这条无法验证——文件进来就只剩 6 个字段，再导出去必然丢东西。
 *
 * 做法：解析时把原始 JSON **以不可枚举属性**挂在结果上（`raw`），导出时以它为底稿、
 * 只覆盖我们真正映射过的字段。于是：
 *  - 没认识的字段（`extensions`、`character_book` 的扩展、世界书条目的 `decorators`…）原样保留；
 *  - 不可枚举意味着它不影响 `deepEqual`、不进 `JSON.stringify`，解析结果的对外形状不变。
 *
 * 边界（写清楚，不假装）：**没有原始 JSON 时**（例如手工构造的领域对象）导出仍能产出合法文件，
 * 但未知字段无从保留——这时函数返回结果里 `lostUnknownFields: true` 由调用方决定怎么提示。
 */

type Json = Record<string, unknown>;

function rawOf(value: unknown): Json | undefined {
  const raw = (value as { raw?: unknown }).raw;
  return isRecord(raw) ? raw : undefined;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 把 `raw` 作为不可枚举属性挂上：对 deepEqual / JSON.stringify 完全不可见。 */
export function attachRaw<T extends object>(target: T, raw: unknown): T {
  if (isRecord(raw)) {
    Object.defineProperty(target, 'raw', { value: raw, enumerable: false, configurable: true, writable: true });
  }
  return target;
}

export interface ExportCharacterOptions {
  /** 目标格式：CCv3（默认，字段在 data 里）/ CCv2 / legacy（扁平）。 */
  format?: 'ccv3' | 'ccv2' | 'legacy';
}

export interface ExportResult {
  /** 建议的文件名（带对扩展名）。 */
  name: string;
  /** 文件全文。 */
  text: string;
  /** 原始 JSON 没带上时，未知字段无法保留 —— 如实告诉调用方。 */
  lostUnknownFields: boolean;
}

/** 角色卡 → JSON 对象（不负责序列化，测试可以逐字段断言）。 */
export function exportCharacterJson(card: ImportedCharacter, options: ExportCharacterOptions = {}): Json {
  const format = options.format ?? 'ccv3';
  const raw = rawOf(card);
  const out: Json = raw === undefined ? {} : deepClone(raw);

  if (format !== 'legacy') {
    if (!isRecord(out['data'])) out['data'] = {};
    out['spec'] = format === 'ccv3' ? 'chara_card_v3' : 'chara_card_v2';
    if (format === 'ccv3' && typeof out['spec_version'] !== 'string') out['spec_version'] = '3.0';
  } else {
    delete out['data'];
  }

  const data: Json = format === 'legacy' ? out : (out['data'] as Json);
  data['name'] = card.name;
  data['description'] = card.description;
  data['personality'] = card.personality;
  data['scenario'] = card.scenario;
  data['first_mes'] = card.firstMessage;
  data['mes_example'] = card.exampleDialogue;
  if (card.alternateGreetings.length > 0) data['alternate_greetings'] = [...card.alternateGreetings];
  else delete data['alternate_greetings'];
  if (card.systemPrompt.trim() !== '') data['system_prompt'] = card.systemPrompt;
  else delete data['system_prompt'];
  if (card.lorebook !== undefined) data['character_book'] = exportLorebookData(card.lorebook);
  return out;
}

/** 世界书 → CCv3 形态的 `character_book` / `data` 对象（数组 entries）。 */
export function exportLorebookData(book: ImportedLorebook): Json {
  const raw = rawOf(book);
  const out: Json = raw === undefined ? {} : deepClone(raw);
  out['name'] = book.name;
  if (book.description.trim() !== '') out['description'] = book.description;
  out['entries'] = book.entries.map((entry) => exportLorebookEntry(entry));
  return out;
}

/** 单条世界书条目：回写已知字段，未知字段（decorators/extensions…）留在原对象里。 */
export function exportLorebookEntry(entry: ImportedLorebookEntry): Json {
  const out: Json = rawOf(entry) === undefined ? {} : deepClone(rawOf(entry) as Json);
  out['keys'] = [...entry.keys];
  // SillyTavern 原生用 key，CCv3 用 keys；两个都写，读哪边都能读到
  out['key'] = entry.keys;
  if (entry.secondaryKeys.length > 0) {
    out['keysecondary'] = [...entry.secondaryKeys];
    out['secondary_keys'] = [...entry.secondaryKeys];
  }
  out['content'] = entry.content;
  if (entry.name.trim() !== '') out['comment'] = entry.name;
  out['enabled'] = entry.enabled;
  out['disable'] = !entry.enabled;
  if (entry.constant) out['constant'] = true;
  else delete out['constant'];
  return out;
}

/** 世界书独立文件（CCv3 独立 lorebook：`spec: 'lorebook_v3'` + `data.entries`）。 */
export function exportLorebookJson(book: ImportedLorebook): Json {
  return { spec: 'lorebook_v3', spec_version: '3.0', data: exportLorebookData(book) };
}

/** 聊天记录 → SillyTavern JSONL（每行一条消息）。 */
export function exportChatJsonl(chat: ImportedChat): string {
  const lines = chat.messages.map((message) => {
    const line: Json = {
      name: message.role === 'user' ? '用户' : chat.characterName,
      is_user: message.role === 'user',
      is_system: message.role === 'system',
      send_date: message.createdAt,
      mes: message.content,
    };
    if (message.candidates !== undefined && message.candidates.length > 1) {
      line['swipes'] = [...message.candidates];
      line['swipe_id'] = message.candidates.indexOf(message.content);
    }
    return JSON.stringify(line);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * 统一入口：按领域对象的类型导出成文件。
 *
 * 文件名沿用来源文件名（去掉旧扩展名），保证"导入 a.png → 导出 a.json"这种直觉成立。
 */
export function exportImported(
  imported: ImportedCharacter | ImportedChat | ImportedLorebook | ImportedLorebookFile,
  sourceName: string,
): ExportResult {
  const base = sourceName.replace(/\.[^.]+$/, '');
  const kind = (imported as { kind?: string }).kind;
  if (kind === 'character') {
    const card = imported as ImportedCharacter;
    return {
      name: `${base || card.name}.json`,
      text: `${JSON.stringify(exportCharacterJson(card), null, 2)}\n`,
      lostUnknownFields: rawOf(card) === undefined,
    };
  }
  if (kind === 'chat') {
    const chat = imported as ImportedChat;
    return { name: `${base || chat.title}.jsonl`, text: exportChatJsonl(chat), lostUnknownFields: true };
  }
  const book = (imported as ImportedLorebookFile).lorebook ?? (imported as ImportedLorebook);
  return {
    name: `${base || book.name}.json`,
    text: `${JSON.stringify(exportLorebookJson(book), null, 2)}\n`,
    lostUnknownFields: rawOf(book) === undefined,
  };
}
