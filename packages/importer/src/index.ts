import { parseCharacterJson, parseLorebook } from './card.ts';
import { describeError } from '../../sync-core/src/error-text.ts';
import { parseChatText } from './chat.ts';
import { extractCardTextFromPng, isPng } from './png.ts';
import { ImportError, isRecord, type Imported } from './types.ts';
import { isZip, readZipEntry } from './zip.ts';

export * from './types.ts';
export { parseCharacterJson, parseLorebook } from './card.ts';
export {
  attachRaw,
  exportCharacterJson,
  exportChatJsonl,
  exportImported,
  exportLorebookEntry,
  exportLorebookJson,
  type ExportCharacterOptions,
  type ExportResult,
} from './export.ts';
export { parseChatText } from './chat.ts';
export { extractCardTextFromPng, isPng, readPngTextChunks } from './png.ts';
export { isZip, listZipEntries, readZipEntry } from './zip.ts';

/**
 * 统一入口：给一段字节 + 文件名，返回"到底是什么、能导入什么"。
 *
 * 判断顺序按**内容**而不是扩展名（用户手里的文件名经常是错的）：
 * PNG 签名 → ZIP 签名 → 文本 JSON / JSONL。
 * 任何失败都变成带 code 的 ImportError，界面负责显示成人话。
 */
export async function importFile(name: string, bytes: Uint8Array): Promise<Imported> {
  try {
    if (isPng(bytes)) {
      const { json } = extractCardTextFromPng(bytes);
      return parseCharacterJson(parseJsonText(json, name), name);
    }

    if (isZip(bytes)) {
      const entry = (await readZipEntry(bytes, (path) => path.toLowerCase().endsWith('.json') && path.toLowerCase().includes('card')))
        ?? (await readZipEntry(bytes, (path) => path.toLowerCase() === 'card.json'))
        ?? (await readZipEntry(bytes, (path) => path.toLowerCase().endsWith('.json')));
      if (entry === undefined) throw new ImportError('no-card-in-charx', '压缩包里没有 card.json');
      const json = new TextDecoder().decode(entry.data);
      return parseCharacterJson(parseJsonText(json, name), name);
    }

    return importText(name, new TextDecoder().decode(bytes));
  } catch (cause) {
    if (cause instanceof ImportError) throw cause;
    throw new ImportError('unreadable', describeError(cause));
  }
}

/** 纯文本导入（JSON 卡 / 世界书 / JSONL 聊天）。 */
export function importText(name: string, text: string): Imported {
  const trimmed = text.trim();
  if (trimmed === '') throw new ImportError('empty-file', '文件是空的');

  // JSONL：第一行是 JSON 对象、且多数行也是——**允许个别坏行**，
  // 因为真实记录里出现半行截断很常见，不该因此把整份记录判成"不是 JSON"。
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '');
  const objectLines = lines.filter((line) => looksLikeJsonObject(line.trim())).length;
  if (lines.length > 1 && objectLines > 0 && objectLines * 2 >= lines.length) {
    return parseChatText(text, name);
  }

  const value = parseJsonText(trimmed, name);
  if (Array.isArray(value)) {
    return { kind: 'lorebook', source: name, lorebook: parseLorebook({ entries: value }, stripExtension(name)), notes: [] };
  }
  if (!isRecord(value)) throw new ImportError('unknown-format', '无法识别的文件格式');

  if (isChatLike(value)) return parseChatText(text, name);

  const data = isRecord(value['data']) ? value['data'] : undefined;
  switch (classify(value)) {
    case 'lorebook':
      return {
        kind: 'lorebook',
        source: name,
        lorebook: parseLorebook(data ?? value, stripExtension(name)),
        notes: [],
      };
    case 'character':
      return parseCharacterJson(value, name);
    default:
      return { kind: 'unknown', source: name, reason: 'JSON 里没有角色卡、世界书或聊天记录该有的字段' };
  }
}

/**
 * 判断一个 JSON 是哪类文件。
 *
 * 现实里三种东西长得像：角色卡（`data.first_mes/description`）、
 * CCv3 世界书（`spec: 'lorebook_v3'`，entries 藏在 `data` 里）、
 * ST 世界书（顶层 `entries` 是 uid→条目 的 map）。所以按"特征字段"判，而不是按文件名。
 */
function classify(value: Record<string, unknown>): 'character' | 'lorebook' | 'unknown' {
  const spec = String(value['spec'] ?? '').toLowerCase();
  if (spec.startsWith('lorebook')) return 'lorebook';

  const data = isRecord(value['data']) ? value['data'] : undefined;
  if (hasCardFields(value)) return 'character';

  if (data !== undefined) {
    if (hasEntries(data) && !hasCardFields(data)) return 'lorebook';
    if (hasCardFields(data) || typeof data['name'] === 'string') return 'character';
  }

  if (hasEntries(value)) return 'lorebook';
  return 'unknown';
}

function hasCardFields(bag: Record<string, unknown>): boolean {
  return ['first_mes', 'description', 'personality', 'scenario', 'mes_example'].some((key) => key in bag);
}

function hasEntries(bag: Record<string, unknown>): boolean {
  return Array.isArray(bag['entries']) || isRecord(bag['entries']);
}

function parseJsonText(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ImportError('bad-json', `${name} 不是合法 JSON`);
  }
}

function looksLikeJsonObject(line: string): boolean {
  if (!line.startsWith('{') || !line.endsWith('}')) return false;
  try {
    return isRecord(JSON.parse(line));
  } catch {
    return false;
  }
}

function isChatLike(value: Record<string, unknown>): boolean {
  if (Array.isArray(value['messages']) && value['messages'].length > 0) return true;
  return 'mes' in value || 'is_user' in value || 'user_name' in value;
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}
