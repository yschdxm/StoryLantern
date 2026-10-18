import { attachRaw } from './export.ts';
import {
  asString,
  asStringArray,
  ImportError,
  isRecord,
  type ImportedCharacter,
  type ImportedLorebook,
  type ImportedLorebookEntry,
  type ImportedQuickReply,
  type ImportedRegexScript,
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
    // ST position 0–7（越界/非法不写）；outlet 名只保留非空
    const positionRaw = asInteger(entry['position']);
    const position = positionRaw !== undefined && positionRaw >= 0 && positionRaw <= 7 ? positionRaw : undefined;
    const outlet = asString(entry['outlet']).trim();
    // ST 用 excludeRecursion 表达"不参与二次触发"；字段缺失时的默认值仍是允许递归
    const excluded = entry['excludeRecursion'] ?? entry['exclude_recursion'];
    // 整词匹配：ST 原生是 matchWholeWords；CCv3/其它导出器可能写 match_whole_words
    const wholeWords = entry['matchWholeWords'] ?? entry['match_whole_words'];
    // ST 高级世界书字段：原样保留（映射到 LoreTrigger 由导入层决定）
    const selectiveLogicRaw = asInteger(entry['selectiveLogic'] ?? entry['selective_logic']);
    const selectiveLogic =
      selectiveLogicRaw === 0 || selectiveLogicRaw === 1 || selectiveLogicRaw === 2 || selectiveLogicRaw === 3
        ? selectiveLogicRaw
        : undefined;
    const preventRecursion = entry['preventRecursion'] ?? entry['prevent_recursion'];
    const delayUntilRaw = entry['delayUntilRecursion'] ?? entry['delay_until_recursion'];
    const delayUntilRecursion =
      typeof delayUntilRaw === 'number' && Number.isFinite(delayUntilRaw)
        ? Math.trunc(delayUntilRaw)
        : typeof delayUntilRaw === 'boolean'
          ? delayUntilRaw
          : undefined;
    const group = asString(entry['group']).trim();
    const groupWeight = asInteger(entry['groupWeight'] ?? entry['group_weight']);
    const sticky = asInteger(entry['sticky']);
    const cooldown = asInteger(entry['cooldown']);
    const delay = asInteger(entry['delay']);
    // 单条预算没有 ST 原生字段：读条目根上的 token_budget/budget，或我们导出时写的 extensions 命名空间
    const extensions = isRecord(entry['extensions']) ? entry['extensions'] : undefined;
    const sl = extensions !== undefined && isRecord(extensions['storylantern']) ? extensions['storylantern'] : undefined;
    const tokenBudget = asInteger(
      entry['token_budget'] ?? entry['budget'] ?? (sl === undefined ? undefined : sl['token_budget']),
    );
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
        ...(position === undefined ? {} : { position }),
        ...(outlet === '' ? {} : { outlet }),
        ...(excluded === undefined ? {} : { recursive: excluded !== true }),
        ...(typeof wholeWords === 'boolean' ? { matchWholeWords: wholeWords } : {}),
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
        ...(selectiveLogic === undefined ? {} : { selectiveLogic }),
        ...(typeof excluded === 'boolean' ? { excludeRecursion: excluded } : {}),
        ...(typeof preventRecursion === 'boolean' ? { preventRecursion } : {}),
        ...(delayUntilRecursion === undefined ? {} : { delayUntilRecursion }),
        ...(group === '' ? {} : { group }),
        ...(groupWeight === undefined ? {} : { groupWeight }),
        ...(sticky === undefined ? {} : { sticky }),
        ...(cooldown === undefined ? {} : { cooldown }),
        ...(delay === undefined ? {} : { delay }),
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
  'depth_prompt', 'group_only_greetings', 'regex_scripts', 'quick_replies',
]);

/** `depth_prompt` 可能是字符串，也可能是 `{ prompt, depth }`（ST 放在 extensions 里）。 */
function depthPromptOf(data: Record<string, unknown>): string {
  const raw = data['depth_prompt'] ?? (isRecord(data['extensions']) ? data['extensions']['depth_prompt'] : undefined);
  if (typeof raw === 'string') return raw.trim();
  if (isRecord(raw)) return asString(raw['prompt']).trim();
  return '';
}

/** 我们已经消费掉的 `extensions` 键：不再进"丢弃清单"。 */
const HANDLED_EXTENSION_KEYS: ReadonlySet<string> = new Set(['regex_scripts', 'quick_replies']);

/** `extensions` 里没消费的值不导入：只留键名，由导入层写进丢弃清单。 */
function extensionKeysOf(data: Record<string, unknown>): string[] {
  const extensions = data['extensions'];
  return isRecord(extensions) ? Object.keys(extensions).filter((key) => !HANDLED_EXTENSION_KEYS.has(key)).sort() : [];
}

/** 正则脚本原始数组：ST 放在 `extensions.regex_scripts`，也容忍根上的 `regex_scripts`。 */
function regexScriptListOf(data: Record<string, unknown>): unknown[] {
  const extensions = isRecord(data['extensions']) ? data['extensions'] : undefined;
  const fromExtensions = extensions === undefined ? undefined : extensions['regex_scripts'];
  const direct = data['regex_scripts'];
  return Array.isArray(fromExtensions) ? fromExtensions : Array.isArray(direct) ? direct : [];
}

/** 正则脚本：解析出可执行的原始条目（字段缺失/不可映射的跳过，由调用方报数量）。 */
function regexScriptsOf(data: Record<string, unknown>): ImportedRegexScript[] {
  const out: ImportedRegexScript[] = [];
  regexScriptListOf(data).forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const findRegex = asString(raw['findRegex']).trim();
    if (findRegex === '') return;
    const placement = (Array.isArray(raw['placement']) ? raw['placement'] : [raw['placement']])
      .map((value) => asInteger(value))
      .filter((value): value is number => value !== undefined && value > 0);
    if (placement.length === 0) return;
    out.push({
      id: asString(raw['id']).trim() || `regex-${index + 1}`,
      name: asString(raw['scriptName']).trim() || asString(raw['name']).trim() || `regex-${index + 1}`,
      findRegex,
      replaceString: asString(raw['replaceString']),
      placement,
      ...(raw['disabled'] === true ? { disabled: true } : {}),
      ...(raw['markdownOnly'] === true ? { markdownOnly: true } : {}),
      ...(raw['promptOnly'] === true ? { promptOnly: true } : {}),
    });
  });
  return out;
}

/** 快捷回复：ST 放在 `extensions.quick_replies`，也容忍根上的 `quick_replies`。 */
function quickRepliesOf(data: Record<string, unknown>): ImportedQuickReply[] {
  const extensions = isRecord(data['extensions']) ? data['extensions'] : undefined;
  const fromExtensions = extensions === undefined ? undefined : extensions['quick_replies'];
  const direct = data['quick_replies'];
  const list = Array.isArray(fromExtensions) ? fromExtensions : Array.isArray(direct) ? direct : [];
  const out: ImportedQuickReply[] = [];
  list.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const content = asString(raw['message'] ?? raw['content']).trim();
    if (content === '') return;
    out.push({
      id: asString(raw['id']).trim() || `qr-${index + 1}`,
      name: asString(raw['label'] ?? raw['name']).trim() || `qr-${index + 1}`,
      content,
      enabled: raw['enabled'] !== false,
    });
  });
  return out;
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
  const regexScripts = regexScriptsOf(data);
  const regexRawCount = regexScriptListOf(data).length;
  if (regexScripts.length > 0) notes.push(`正则脚本 ${regexScripts.length} 条已解析（执行引擎已就绪，聊天链路接线在下一批）`);
  if (regexRawCount > regexScripts.length) {
    notes.push(`正则脚本 ${regexRawCount} 条中有 ${regexRawCount - regexScripts.length} 条缺少 findRegex/placement，已跳过（不猜）`);
  }
  const quickReplies = quickRepliesOf(data);
  if (quickReplies.length > 0) notes.push(`快捷回复 ${quickReplies.length} 条已解析（暂无 UI 入口）`);

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
      ...(regexScripts.length === 0 ? {} : { regexScripts }),
      ...(quickReplies.length === 0 ? {} : { quickReplies }),
      notes,
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
 * 已改为真解析（`regexScriptsOf`）：这里只保留被其它地方引用的旧函数名会误报，
 * 因此直接删除，避免"只计数不导入"的旧语义残留。
 */

