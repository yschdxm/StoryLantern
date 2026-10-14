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

  const alternates = asStringArray(data['alternate_greetings']);
  if (alternates.length > 0) notes.push(`另有 ${alternates.length} 条备选开场白，v0.1 只保留第一条`);
  if (asString(data['system_prompt']) !== '') notes.push('卡片自带 system prompt，v0.1 未启用');
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
    spec: spec === '' ? 'legacy' : spec,
    ...(lorebook === undefined ? {} : { lorebook }),
    notes,
  };
}

/** 描述为空时把 creator notes 放进去，避免"导入后一片空白"。 */
function withCreatorNotes(description: string, data: Record<string, unknown>): string {
  if (description.trim() !== '') return description;
  const notes = asString(data['creator_notes']).trim();
  return notes === '' ? description : notes;
}
