/**
 * 导入器的领域类型。
 *
 * 这一步刻意**不碰仓储、不认识界面**：把"文件字节 → 结构化内容"做干净，
 * 上层（应用）再决定怎么落库。好处是全部逻辑都能用 fixtures 里的真实样本测。
 */

export interface ImportedLorebookEntry {
  keys: string[];
  secondaryKeys: string[];
  content: string;
  /** 条目名（comment/name）。 */
  name: string;
  enabled: boolean;
  constant: boolean;
  /** ST 的插入顺序（`order` / CCv3 的 `insertion_order`）；缺省时由调用方按导入顺序编号。 */
  order?: number;
  /** ST 的深度窗口（`depth`）；0/缺省 = 用默认窗口。 */
  depth?: number;
  /** 是否允许递归扫描（ST 的 `excludeRecursion` 取反）；缺省 true。 */
  recursive?: boolean;
  /**
   * 整词匹配（ST 的 `matchWholeWords` / CCv3 的 `match_whole_words`）。
   * 缺省 = 没给（不要写 false：false 与"没给"在语义上都是子串匹配，但导出会多一个字段）。
   */
  matchWholeWords?: boolean;
  /**
   * 单条内容预算（token/字符预算）。ST 世界书**没有这个原生字段**：
   * 从条目根上的 `token_budget` / `budget`，或我们导出时写的 `extensions.storylantern.token_budget` 读回。
   */
  tokenBudget?: number;
  /** ST `selectiveLogic`（0–3，原样保留）；app 映射到 `LoreTrigger.selective_logic`。 */
  selectiveLogic?: 0 | 1 | 2 | 3;
  /** ST `excludeRecursion` 原始值（`recursive` 已表达其取反；保留原字段供导入层精确映射）。 */
  excludeRecursion?: boolean;
  /** ST `preventRecursion`。 */
  preventRecursion?: boolean;
  /** ST `delayUntilRecursion`（布尔或数字，原样保留）。 */
  delayUntilRecursion?: boolean | number;
  /** ST `group` / `groupWeight`。 */
  group?: string;
  groupWeight?: number;
  /** ST `sticky` / `cooldown` / `delay`（轮次）。 */
  sticky?: number;
  cooldown?: number;
  delay?: number;
}

export interface ImportedLorebook {
  name: string;
  description: string;
  entries: ImportedLorebookEntry[];
}

/** 酒馆 `regex_scripts` 的原始条目（字段名保持 ST 原名，placement 保留数字）。 */
export interface ImportedRegexScript {
  id: string;
  name: string;
  /** ST `findRegex`：`/pattern/flags` 或裸 pattern。 */
  findRegex: string;
  replaceString: string;
  /** ST placement 数字（1=USER_INPUT、2=AI_OUTPUT、5=WORLD_INFO、6=REASONING）。 */
  placement: number[];
  disabled?: boolean;
  markdownOnly?: boolean;
  promptOnly?: boolean;
}

/** 酒馆快捷回复原始条目（`extensions.quick_replies`）。 */
export interface ImportedQuickReply {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
}

export interface ImportedCharacter {
  kind: 'character';
  /** 来源文件名，用于界面提示与排错。 */
  source: string;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  exampleDialogue: string;
  /** 卡片自带的 system prompt（空 = 用应用里的全局提示）。 */
  systemPrompt: string;
  /** 备选开场白（第一条仍在 `firstMessage`）。 */
  alternateGreetings: string[];
  /** 卡片规范版本：`chara_card_v2` / `chara_card_v3` / `legacy`。 */
  spec: string;
  /** 作者（ST `creator`）。 */
  creator?: string;
  /** 卡片版本（ST `character_version`）。 */
  characterVersion?: string;
  /** 作者备注（ST `creator_notes`）——可作卡片简介，不再"跳过"。 */
  creatorNotes?: string;
  /** 回复后指令（ST `post_history_instructions`）。 */
  postHistoryInstructions?: string;
  /** ST `tags`。 */
  tags?: string[];
  /** ST `depth_prompt` 的正文（没有承载字段，导入时会被丢弃并如实报告）。 */
  depthPrompt?: string;
  /** 群聊专用开场白（ST `group_only_greetings`）。 */
  groupOnlyGreetings?: string[];
  /** `extensions` 的键名：值不导入（只留审计），键名用于丢弃清单。 */
  extensionKeys?: string[];
  /** 我们没有映射的 `data` 字段名：如实上报丢弃，不静默。 */
  unmappedFields?: string[];
  lorebook?: ImportedLorebook;
  /** 酒馆正则脚本（`extensions.regex_scripts` / 根上 `regex_scripts`）；由导入层决定是否存进卡片。 */
  regexScripts?: ImportedRegexScript[];
  /** 酒馆快捷回复（`extensions.quick_replies`）。 */
  quickReplies?: ImportedQuickReply[];
  /** 丢掉了什么、可能影响什么——宁可写清楚，也不静默丢数据。 */
  notes: string[];
}

export interface ImportedChatMessage {
  role: 'user' | 'assistant' | 'system';
  /** 当前选中的那条（SillyTavern 里的 swipe id 指向它）。 */
  content: string;
  /** 同一位置的其它候选回复（SillyTavern 的 swipes）；不再被丢掉。 */
  candidates?: string[];
  createdAt: number;
}

export interface ImportedChat {
  kind: 'chat';
  source: string;
  /** 聊天记录里的角色名（用来找/建对应角色）。 */
  characterName: string;
  title: string;
  messages: ImportedChatMessage[];
  notes: string[];
}

export interface ImportedLorebookFile {
  kind: 'lorebook';
  source: string;
  lorebook: ImportedLorebook;
  notes: string[];
}

export interface ImportedUnknown {
  kind: 'unknown';
  source: string;
  reason: string;
}

export type Imported = ImportedCharacter | ImportedChat | ImportedLorebookFile | ImportedUnknown;

/** 导入失败：`code` 供界面分支，`message` 直接给用户看。 */
export class ImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter((item) => item !== '');
  const single = asString(value);
  return single === '' ? [] : [single];
}
