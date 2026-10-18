/**
 * 正则脚本（B13）：**纯函数**执行引擎 + 酒馆格式转换，不接聊天流程（接线是下一批）。
 *
 * 语义：
 *  - 按数组顺序执行；`enabled === false` 不执行；placement 不匹配不执行。
 *  - 非法正则**跳过并计数**（`{id, reason}`），绝不 throw——一张坏卡不能把整个请求打断。
 *  - 防灾难性回溯：JS 没有可中断的正则执行，这里只能做上限（脚本数 ≤50、文本 ≤256KB），
 *    超限跳过并计数。**这不是沙箱**，只是把明显失控的输入挡在门外。
 *
 * 酒馆 placement 数字：1=USER_INPUT、2=AI_OUTPUT、5=WORLD_INFO、6=REASONING（其它值跳过）。
 */

export type RegexPlacement = 'user_input' | 'ai_output' | 'world_info' | 'reasoning';

export interface RegexFlags {
  global?: boolean;
  caseInsensitive?: boolean;
  multiline?: boolean;
  /** ST 的 `s`（`.` 匹配换行）；缺失会改变多行匹配结果，所以保留。 */
  dotAll?: boolean;
}

export interface RegexScript {
  id: string;
  name: string;
  /** 不含 `/.../` 的 pattern 本体。 */
  find: string;
  replace: string;
  placement: RegexPlacement;
  flags?: RegexFlags;
  enabled?: boolean;
}

export interface RegexSkipped {
  id: string;
  /** `invalid_pattern` / `empty_pattern` / `text_too_large` / `too_many_scripts`。 */
  reason: string;
}

export interface RegexResult {
  text: string;
  /** 成功执行（含 0 次匹配）的脚本数。 */
  applied: number;
  skipped: RegexSkipped[];
}

/** 上限：单次最多执行 50 条脚本；文本超过 256 KiB（UTF-16 码元）直接不跑。 */
export const MAX_REGEX_SCRIPTS = 50;
export const MAX_REGEX_TEXT_LENGTH = 256 * 1024;

const ST_PLACEMENT_TO_NAME: Readonly<Record<number, RegexPlacement>> = {
  1: 'user_input',
  2: 'ai_output',
  5: 'world_info',
  6: 'reasoning',
};

const NAME_TO_ST_PLACEMENT: Readonly<Record<RegexPlacement, number>> = {
  user_input: 1,
  ai_output: 2,
  world_info: 5,
  reasoning: 6,
};

function flagsString(flags: RegexFlags | undefined): string {
  if (flags === undefined) return '';
  return `${flags.global === true ? 'g' : ''}${flags.caseInsensitive === true ? 'i' : ''}${flags.multiline === true ? 'm' : ''}${flags.dotAll === true ? 's' : ''}`;
}

function flagsOf(value: string): RegexFlags {
  const flags: RegexFlags = {};
  if (value.includes('g')) flags.global = true;
  if (value.includes('i')) flags.caseInsensitive = true;
  if (value.includes('m')) flags.multiline = true;
  if (value.includes('s')) flags.dotAll = true;
  return flags;
}

/** `/pattern/flags` → `{find, flags}`；没有斜杠时把整串当 pattern（宽容导入）。 */
export function parseRegexLiteral(value: string): { find: string; flags: RegexFlags } {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('/') && text.lastIndexOf('/') > 0) {
    const last = text.lastIndexOf('/');
    return { find: text.slice(1, last).replaceAll('\\/', '/'), flags: flagsOf(text.slice(last + 1)) };
  }
  return { find: text, flags: {} };
}

/** `{find, flags}` → 酒馆 `findRegex` 字面量（导出用）。 */
export function formatRegexLiteral(find: string, flags: RegexFlags | undefined): string {
  return `/${find.replaceAll('/', '\\/')}/${flagsString(flags)}`;
}

/** 执行一次 placement 匹配的脚本；不修改输入。 */
export function applyRegexScripts(
  text: string,
  placement: RegexPlacement,
  scripts: readonly RegexScript[],
): RegexResult {
  const skipped: RegexSkipped[] = [];
  if (text.length > MAX_REGEX_TEXT_LENGTH) {
    return { text, applied: 0, skipped: [{ id: '*', reason: 'text_too_large' }] };
  }
  const matching = scripts.filter((script) => script.enabled !== false && script.placement === placement);
  for (const script of matching.slice(MAX_REGEX_SCRIPTS)) {
    skipped.push({ id: script.id, reason: 'too_many_scripts' });
  }
  let current = text;
  let applied = 0;
  for (const script of matching.slice(0, MAX_REGEX_SCRIPTS)) {
    if (script.find === '') {
      skipped.push({ id: script.id, reason: 'empty_pattern' });
      continue;
    }
    let regex: RegExp;
    try {
      regex = new RegExp(script.find, flagsString(script.flags));
    } catch {
      skipped.push({ id: script.id, reason: 'invalid_pattern' });
      continue;
    }
    current = current.replace(regex, script.replace);
    applied += 1;
  }
  return { text: current, applied, skipped };
}

/** 解析器从酒馆解析出来的原始条目（字段名保持 ST 原名，app 层再转模型）。 */
export interface StRegexScript {
  id?: unknown;
  scriptName?: unknown;
  findRegex?: unknown;
  replaceString?: unknown;
  placement?: unknown;
  disabled?: unknown;
  markdownOnly?: unknown;
  promptOnly?: unknown;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 酒馆 `regex_scripts` → 我们的模型：placement 数字取第一个受支持的、非法条目跳过。 */
export function regexScriptsFromSt(list: readonly unknown[]): RegexScript[] {
  const out: RegexScript[] = [];
  list.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const findRegex = textOf(raw['findRegex']).trim();
    if (findRegex === '') return;
    const placementList = Array.isArray(raw['placement']) ? raw['placement'] : [raw['placement']];
    const placement = placementList
      .map((value) => (typeof value === 'number' ? ST_PLACEMENT_TO_NAME[value] : undefined))
      .find((value): value is RegexPlacement => value !== undefined);
    if (placement === undefined) return;
    const id = textOf(raw['id']).trim() || `regex-${index + 1}`;
    const name = textOf(raw['scriptName']).trim() || id;
    const parsed = parseRegexLiteral(findRegex);
    out.push({
      id,
      name,
      find: parsed.find,
      replace: textOf(raw['replaceString']),
      placement,
      ...(Object.keys(parsed.flags).length === 0 ? {} : { flags: parsed.flags }),
      ...(raw['disabled'] === true ? { enabled: false } : {}),
    });
  });
  return out;
}

/** 我们的模型 → 酒馆 `regex_scripts` 原始条目（导出用；能再被 `regexScriptsFromSt` 读回）。 */
export function regexScriptsToSt(scripts: readonly RegexScript[]): StRegexScript[] {
  return scripts.map((script) => ({
    id: script.id,
    scriptName: script.name,
    findRegex: formatRegexLiteral(script.find, script.flags),
    replaceString: script.replace,
    placement: [NAME_TO_ST_PLACEMENT[script.placement]],
    disabled: script.enabled === false,
    markdownOnly: false,
    promptOnly: false,
  }));
}

/** 从卡片 `extensions.storylantern.regex_scripts` 里安全取出脚本（未知/坏形状按空/跳过）。 */
export function regexScriptsOfExtensions(extensions: Readonly<Record<string, unknown>> | undefined): RegexScript[] {
  const story = extensions === undefined ? undefined : extensions['storylantern'];
  const list = isRecord(story) ? story['regex_scripts'] : undefined;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (item): item is RegexScript =>
      isRecord(item) &&
      typeof item['id'] === 'string' &&
      typeof item['name'] === 'string' &&
      typeof item['find'] === 'string' &&
      typeof item['replace'] === 'string' &&
      (item['placement'] === 'user_input' ||
        item['placement'] === 'ai_output' ||
        item['placement'] === 'world_info' ||
        item['placement'] === 'reasoning'),
  );
}
