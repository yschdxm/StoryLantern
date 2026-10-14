import {
  asString,
  asStringArray,
  ImportError,
  isRecord,
  type ImportedCharacter,
  type ImportedLorebook,
  type ImportedLorebookEntry,
} from './types.ts';

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
    return {
      keys: asStringArray(entry['key'] ?? entry['keys']),
      secondaryKeys: asStringArray(entry['keysecondary'] ?? entry['secondary_keys']),
      content: asString(entry['content']),
      name: asString(entry['comment'] ?? entry['name']),
      enabled: entry['enabled'] === true ? true : !disabled,
      constant: entry['constant'] === true,
    };
  });

  return {
    name: asString(value['name']) || fallbackName,
    description: asString(value['description']),
    entries,
  };
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

/**
 * 角色卡 JSON → 领域对象。
 *
 * 支持三种形态：
 *  - `{spec:'chara_card_v2'|'chara_card_v3', data:{...}}`
 *  - `{spec:'chara_card_v1'}`（与 legacy 同构）
 *  - 扁平 legacy：字段就在顶层
 *
 * 关键取舍：**只映射 v0.1 界面已有的 6 个字段**，其余（alternate_greetings、system_prompt、
 * extensions…）不假装支持——写进 notes 让用户知道丢了什么。
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
  const alternates = asStringArray(data['alternate_greetings'])
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (alternates.length > 0) notes.push(`另带入 ${alternates.length} 条备选开场白（可在角色里切换）`);
  const cardPrompt = asString(data['system_prompt']).trim();
  if (cardPrompt !== '') notes.push('卡片自带 system prompt 已带入角色（优先于全局提示）');
  if (asString(data['creator_notes']) !== '') notes.push('跳过 creator notes');

  return {
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
    ...(lorebook === undefined ? {} : { lorebook }),
    notes:
      regexScriptCount(data) === 0
        ? notes
        : [...notes, `${regexScriptCount(data)} 条正则脚本没有导入：当前版本不执行正则（要么接进生成链路，要么不导，不做半支持）`],
  };
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
