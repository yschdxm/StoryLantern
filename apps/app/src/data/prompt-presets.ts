/**
 * ST 提示词预设（B1/B22/B29 的**兼容导入/导出**层）：只存档与导出，**不接运行时装配**。
 *
 * 边界：
 *  - 运行时块顺序仍由自有块注册表（`prompt-blocks-v2.ts`）决定；这里**不读** `prompt_order`、
 *    不按预设的 `prompts[]` 拼提示词。用户导入后只是"存档 + 可原样导出"。
 *  - 能识别 SillyTavern Chat Completion（`prompts[]` / `prompt_order[]`）与
 *    Text Completion（`story_string` / `chat_start` 等）；识别不了就明确报错，不猜。
 *  - `raw` 保留整个解析后的对象，导出原样写回；`notes` 固定写明"仅存档/导出"。
 *  - 存储走设置键 `prompt.presets.v1`（JSON 数组；本机/同步按 settings 现状，不新增 op），
 *    上限 50 条；坏条目跳过并计数，去重 by id / name。
 */

export const PRESET_SETTING_KEY = 'prompt.presets.v1';
export const MAX_PRESETS = 50;
export const PRESET_ARCHIVE_NOTE = '本应用不按该预设装配，仅存档/导出（B1/B29 兼容）';

export type PresetKind = 'chat_completion' | 'text_completion';

export interface PromptPreset {
  id: string;
  name: string;
  kind: PresetKind;
  source: 'st';
  /** 完整原始 JSON（无损导出用）。 */
  raw: unknown;
  importedAt: number;
  notes?: string[];
}

export type PresetErrorCode = 'bad-json' | 'not-object' | 'unknown-format';

export type ParsePresetResult =
  | { ok: true; preset: PromptPreset }
  | { ok: false; code: PresetErrorCode; error: string };

export interface ParsePresetOptions {
  /** 导入时间（测试传固定值；缺省 Date.now()）。 */
  now?: number;
  /** 显式 id（缺省按文件内容哈希，稳定且可去重）。 */
  id?: string;
  /** 显式名字（缺省取预设里的 `name`，再缺省按格式命名）。 */
  name?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** FNV-1a：同一份文件得到同一个 id（不依赖时间/随机）。 */
function hashId(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `st-${(hash >>> 0).toString(16)}`;
}

/** ST Chat Completion：带 `prompts[]` 或 `prompt_order`（新老格式都算）。 */
function isChatCompletion(raw: Record<string, unknown>): boolean {
  return Array.isArray(raw['prompts']) || Array.isArray(raw['prompt_order']) || isRecord(raw['prompt_order']);
}

/** ST Text Completion：`story_string` / `chat_start` / `example_dialogue` 这类 TC 专有字段。 */
function isTextCompletion(raw: Record<string, unknown>): boolean {
  return ['story_string', 'chat_start', 'example_dialogue', 'personality_format'].some((key) => key in raw);
}

/** 解析预设文件：坏 JSON / 非对象 / 无法识别都返回错误（不静默）。 */
export function parsePresetFile(text: string, options: ParsePresetOptions = {}): ParsePresetResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, code: 'bad-json', error: '不是合法 JSON：请确认导出的是 ST 预设文件' };
  }
  if (!isRecord(parsed)) {
    return { ok: false, code: 'not-object', error: '预设文件顶层不是对象：无法识别' };
  }
  const kind: PresetKind | undefined = isChatCompletion(parsed)
    ? 'chat_completion'
    : isTextCompletion(parsed)
      ? 'text_completion'
      : undefined;
  if (kind === undefined) {
    return {
      ok: false,
      code: 'unknown-format',
      error: '既不是 ST Chat Completion（prompts/prompt_order）也不是 Text Completion（story_string/chat_start）预设',
    };
  }
  const rawName = typeof parsed['name'] === 'string' ? parsed['name'].trim() : '';
  const name = (options.name ?? rawName) === '' ? `ST ${kind === 'chat_completion' ? 'Chat' : 'Text'} 预设` : (options.name ?? rawName);
  return {
    ok: true,
    preset: {
      id: options.id ?? hashId(text),
      name,
      kind,
      source: 'st',
      raw: parsed,
      importedAt: options.now ?? Date.now(),
      notes: [PRESET_ARCHIVE_NOTE],
    },
  };
}

/** 导出：`raw` 优先，原样写回（不夹带本应用的字段）。 */
export function serializePresetFile(preset: PromptPreset): string {
  return JSON.stringify(preset.raw, null, 2);
}

function normalizeNote(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 单条存储记录的校验：坏条目返回 undefined（由调用方计数）。 */
function normalizeEntry(value: unknown): PromptPreset | undefined {
  if (!isRecord(value)) return undefined;
  const id = typeof value['id'] === 'string' ? value['id'].trim() : '';
  const name = typeof value['name'] === 'string' ? value['name'].trim() : '';
  const kind = value['kind'];
  if (id === '' || name === '' || (kind !== 'chat_completion' && kind !== 'text_completion')) return undefined;
  if (!isRecord(value['raw'])) return undefined;
  const importedAt =
    typeof value['importedAt'] === 'number' && Number.isFinite(value['importedAt']) ? value['importedAt'] : 0;
  const notes = normalizeNote(value['notes']);
  return {
    id,
    name,
    kind,
    source: 'st',
    raw: value['raw'],
    importedAt,
    ...(notes.length === 0 ? {} : { notes }),
  };
}

export interface PresetList {
  presets: PromptPreset[];
  /** 坏条目 / 重复条目的条数（不静默）。 */
  skipped: number;
}

/** 读取设置里的预设数组：坏 JSON/坏条目跳过并计数。 */
export function listPresets(settings: Record<string, string>): PresetList {
  const raw = settings[PRESET_SETTING_KEY];
  if (raw === undefined || raw.trim() === '') return { presets: [], skipped: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { presets: [], skipped: 1 };
  }
  if (!Array.isArray(parsed)) return { presets: [], skipped: 1 };
  const presets: PromptPreset[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  let skipped = 0;
  for (const item of parsed) {
    const preset = normalizeEntry(item);
    if (preset === undefined) {
      skipped += 1;
      continue;
    }
    const nameKey = preset.name.trim().toLowerCase();
    if (seenIds.has(preset.id) || seenNames.has(nameKey)) {
      skipped += 1;
      continue;
    }
    seenIds.add(preset.id);
    seenNames.add(nameKey);
    presets.push(preset);
  }
  return { presets, skipped };
}

function writeStore(settings: Record<string, string>, presets: readonly PromptPreset[]): Record<string, string> {
  return { ...settings, [PRESET_SETTING_KEY]: JSON.stringify(presets) };
}

export interface SavePresetResult {
  settings: Record<string, string>;
  saved: boolean;
  /** `full` = 已有 50 条且不是替换（设置不变，调用方需提示）。 */
  reason?: 'full';
}

/** 保存：按 id / name（忽略大小写）替换，否则追加；满 50 条不再追加。 */
export function savePreset(settings: Record<string, string>, preset: PromptPreset): SavePresetResult {
  const { presets } = listPresets(settings);
  const index = presets.findIndex(
    (item) => item.id === preset.id || item.name.trim().toLowerCase() === preset.name.trim().toLowerCase(),
  );
  if (index < 0 && presets.length >= MAX_PRESETS) {
    return { settings, saved: false, reason: 'full' };
  }
  const next = index < 0 ? [...presets, preset] : presets.map((item, position) => (position === index ? preset : item));
  return { settings: writeStore(settings, next), saved: true };
}

/** 删除：找不到也不报错（幂等），返回新的 settings。 */
export function removePreset(settings: Record<string, string>, id: string): Record<string, string> {
  const { presets } = listPresets(settings);
  return writeStore(settings, presets.filter((item) => item.id !== id));
}

/** 导出整组预设（给"导出全部"用）：JSON 数组，仍是原样 raw。 */
export function serializePresetCollection(presets: readonly PromptPreset[]): string {
  return JSON.stringify(presets.map((preset) => preset.raw), null, 2);
}
