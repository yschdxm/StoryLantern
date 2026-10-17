import { attachRaw } from './export.ts';
import {
  asString,
  asStringArray,
  ImportError,
  isRecord,
  type ImportedCharacter,
  type ImportedLorebook,
  type ImportedLorebookEntry,
} from './types.ts';

/** ST 的数值字段既可能是 number 也可能是数字字符串；非数字一律当"没给"。 */
function asInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return undefined;
}

/** 世界书：SillyTavern 原生（`entries` 为 uid→条目 的 map）与 CCv3（数组 + decorators）两种形态。 */

export function parseLorebook(value: unknown, fallbackName: string): ImportedLorebook {
  if (!isRecord(value)) throw new ImportError('bad-lorebook', '世界书不是对象');
  const rawEntries = value['entries'];
  const list: unknown[] = Array.isArray(rawEntries)
    ? rawEntries
    : isRecord(rawEntries)
      ? Object.values(rawEntries)
      : [];
  if (list.length === 0) throw new ImportError('bad-lorebook', '世界书里没有条目');

  const entries: ImportedLorebookEntry[] = list.filter(isRecord).map((entry) => {
    const disabled = entry['disable'] === true || entry['enabled'] === false;
    const order = asInteger(entry['order'] ?? entry['insertion_order']);
    const depth = asInteger(entry['depth']);
    // ST 用 excludeRecursion 表达"不参与二次触发"；字段缺失时的默认值仍是允许递归
    const excluded = entry['excludeRecursion'] ?? entry['exclude_recursion'];
    return attachRaw(
      {
        keys: asStringArray(entry['key'] ?? entry['keys']),
        secondaryKeys: asStringArray(entry['keysecondary'] ?? entry['secondary_keys']),
        content: asString(entry['content']),
        name: asString(entry['comment'] ?? entry['name']),
        enabled: entry['enabled'] === true ? true : !disabled,
        constant: entry['constant'] === true,
        ...(order === undefined ? {} : { order }),
        ...(depth === undefined ? {} : { depth }),
        ...(excluded === undefined ? {} : { recursive: excluded !== true }),
      },
      entry,
    );
  });

  return attachRaw(
    {
      name: asString(value['name']) || fallbackName,
      description: asString(value['description']),
      entries,
    },
    value,
  );
}

/** 角色卡里内嵌的世界书（CCv2/CCv3 的 `character_book`）。没有就返回 undefined。 */
export function parseEmbeddedLorebook(cardData: Record<string, unknown>, fallbackName: string): ImportedLorebook | undefined {
  const book = cardData['character_book'];
  if (!isRecord(book)) return undefined;
  try {
    return parseLorebook(book, fallbackName);
  } catch {
    // 内嵌世界书坏了不该让整张卡导入失败：记一条 note 由调用方处理
    return undefined;
  }
}

/** 我们已经映射（或明确处理）的 data 字段：其余字段如实进 discarded，不静默丢。 */
const HANDLED_CARD_FIELDS: ReadonlySet<string> = new Set([
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions', 'alternate_greetings',
  'tags', 'creator', 'character_version', 'extensions', 'character_book',
  'depth_prompt', 'group_only_greetings',
]);

/** `depth_prompt` 可能是字符串，也可能是 `{ prompt, depth }`（ST 放在 extensions 里）。 */
function depthPromptOf(data: Record<string, unknown>): string {
  const raw = data['depth_prompt'] ?? (isRecord(data['extensions']) ? data['extensions']['depth_prompt'] : undefined);
  if (typeof raw === 'string') return raw.trim();
  if (isRecord(raw)) return asString(raw['prompt']).trim();
  return '';
}

/** `extensions` 的值不导入：只留键名，由导入层写进丢弃清单。 */
function extensionKeysOf(data: Record<string, unknown>): string[] {
  const extensions = data['extensions'];
  return isRecord(extensions) ? Object.keys(extensions).sort() : [];
}

/** 我们没有映射的顶层 data 字段（`nickname`/`assets` 之类）：如实上报。 */
function unmappedFieldsOf(data: Record<string, unknown>): string[] {
  return Object.keys(data)
    .filter((key) => !HANDLED_CARD_FIELDS.has(key) && key !== 'spec' && key !== 'spec_version')
    .sort();
}

function trimmedStrings(value: unknown): string[] {
  return asStringArray(value)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 角色卡 JSON → 领域对象。
 *
 * 支持三种形态：
 *  - `{spec:'chara_card_v2'|'chara_card_v3', data:{...}}`
 *  - `{spec:'chara_card_v1'}`（与 legacy 同构）
 *  - 扁平 legacy：字段就在顶层
 *
 * 这里把**酒馆侧可映射的字段全部解析出来**（作者/版本/tags/回复后指令/群聊开场…），
 * 是否进卡片、进草稿、还是丢弃由上层 `import-cards.ts` 按 §15 决定；解析器不擅自丢数据。
 */
export function parseCharacterJson(value: unknown, source: string): ImportedCharacter {
  if (!isRecord(value)) throw new ImportError('bad-card', '角色卡不是对象');

  const spec = asString(value['spec']);
  const data = isRecord(value['data']) ? value['data'] : value;
  const name = asString(data['name']).trim();
  if (name === '') throw new ImportError('bad-card', '角色卡里没有名字');

  const notes: string[] = [];
  const lorebook = parseEmbeddedLorebook(data, `${name} 的世界书`);
  if (isRecord(data['character_book']) && lorebook === undefined) {
    notes.push('内嵌世界书无法解析，已跳过');
  } else if (lorebook !== undefined) {
    notes.push(`内嵌世界书 ${lorebook.entries.length} 条已一并导入`);
  }

  // 备选开场白与卡片自带的 system prompt 都带进角色：不再"只留第一条/未启用"
  const alternates = trimmedStrings(data['alternate_greetings']);
  if (alternates.length > 0) notes.push(`另带入 ${alternates.length} 条备选开场白（可在角色里切换）`);
  const cardPrompt = asString(data['system_prompt']).trim();
  if (cardPrompt !== '') notes.push('卡片自带 system prompt 已带入角色（优先于全局提示）');
  if (asString(data['creator_notes']).trim() !== '') notes.push('creator notes 已作为卡片简介带入');

  return attachRaw(
    {
      kind: 'character',
      source,
      name: name.slice(0, 60),
      description: withCreatorNotes(asString(data['description']), data),
      personality: asString(data['personality']),
      scenario: asString(data['scenario']),
      firstMessage: asString(data['first_mes']),
      exampleDialogue: asString(data['mes_example']),
      systemPrompt: cardPrompt,
      alternateGreetings: alternates,
      spec: spec === '' ? 'legacy' : spec,
      creator: asString(data['creator']),
      characterVersion: asString(data['character_version']),
      creatorNotes: asString(data['creator_notes']),
      postHistoryInstructions: asString(data['post_history_instructions']),
      tags: trimmedStrings(data['tags']),
      depthPrompt: depthPromptOf(data),
      groupOnlyGreetings: trimmedStrings(data['group_only_greetings']),
      extensionKeys: extensionKeysOf(data),
      unmappedFields: unmappedFieldsOf(data),
      ...(lorebook === undefined ? {} : { lorebook }),
      notes:
        regexScriptCount(data) === 0
          ? notes
          : [...notes, `${regexScriptCount(data)} 条正则脚本没有导入：当前版本不执行正则（要么接进生成链路，要么不导，不做半支持）`],
    },
    value,
  );
}

/** 描述为空时把 creator notes 放进去，避免"导入后一片空白"。 */
function withCreatorNotes(description: string, data: Record<string, unknown>): string {
  if (description.trim() !== '') return description;
  const notes = asString(data['creator_notes']).trim();
  return notes === '' ? description : notes;
}

/**
 * 卡片里的正则脚本条数（SillyTavern 放在 extensions.regex_scripts，也有放在根上的）。
 *
 * 我们**不导入也不假装支持**：正则要么真接进生成链路，要么明确不导——只把条数报给用户，
 * 免得"导入成功"却少了一块行为。
 */
function regexScriptCount(data: Record<string, unknown>): number {
  const extensions = data['extensions'];
  const fromExtensions =
    extensions !== null && typeof extensions === 'object'
      ? (extensions as Record<string, unknown>)['regex_scripts']
      : undefined;
  const direct = data['regex_scripts'];
  const list = Array.isArray(fromExtensions) ? fromExtensions : Array.isArray(direct) ? direct : [];
  return list.length;
}
