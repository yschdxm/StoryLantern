/**
 * 世界书扫描：**纯函数**，零依赖，因此可以被单测穷举、也能在任意端复用。
 *
 * 语义参考 SillyTavern 的世界书（那套心智模型用户已经熟悉），但只保留真正有用的部分，
 * 并把每条规则都写成能被测试断言的形式：
 *
 *  - **关键词**：主关键词命中任意一个即可；次级关键词按 `selectiveLogic` 组合（见下）。
 *  - **selectiveLogic**：0/缺省 = AND ANY（次键任选）；1 = NOT ALL；2 = NOT ANY；3 = AND ALL。
 *    次级关键词为空时三种变体都退化为"只看主键"（与 ST 一致）。
 *  - **大小写**：默认不敏感；`caseSensitive` 打开后按原文比较。
 *  - **整词**：`matchWholeWords` 打开后，**英文/ASCII 词**要求两侧不是字母/数字/下划线
 *    （`bell` 不命中 `umbrella`）；含非 ASCII 的关键词（CJK 等）仍按子串（`铃` 命中 `铜铃`）。
 *  - **深度窗口**：`depth = N` 只看最近 N 条消息；`depth = 0` 用调用方给的默认深度；`extraText` 永远参与。
 *  - **递归**：命中条目正文会追加进扫描文本再扫一轮（`recursive:false` 不参与）。`excludeRecursion`
 *    命中内容不参与二次匹配；`preventRecursion` 不被二次匹配命中；`delayUntilRecursion` 前 N 个
 *    **历史轮次**不参与递归（直接命中不受限）。
 *  - **轮次语义**（`turn = messages.length`，纯函数、无随机；历史命中按"每轮最后一条消息"判定）：
 *    `delay=N` 总轮次 < N 不参与；`cooldown=N` 上次命中后 N 轮内不再命中；
 *    `sticky=N` 上次命中后 N 轮内继续注入（`reason:'sticky'`）。
 *  - **group**：同组命中多条只留一条；有 `groupWeight` 用**确定性哈希**抽取（禁止 Math.random），
 *    都没有权重时保留优先级最高（`order` 最小）的一条；被丢掉的计入 `suppressed`。
 *  - **预算**：按 `order` 升序贪心放入，放不下的记为 `dropped`；单条 `tokenBudget` 由上层装配器截断。
 *
 * 输出**与输入顺序无关**（同分按 bookId/entryId 排序），因此两台设备、两次调用都得到同样的注入，
 * 这既是可解释性的前提，也是同步一致性的前提。
 */

export type SelectiveLogic = 0 | 1 | 2 | 3;

export interface ScanEntry {
  id: string;
  keys: readonly string[];
  secondaryKeys?: readonly string[];
  content: string;
  enabled?: boolean;
  order?: number;
  caseSensitive?: boolean;
  /** 整词匹配：只影响 ASCII 词；CJK 仍子串。 */
  matchWholeWords?: boolean;
  /**
   * 单条内容字符预算。扫描器**不截断**（只返回原文）；由上层装配器决定怎么截
   * （`prompt-lore.ts` 按 Unicode 码点截断并加 `…`）。保留字段是为了语义集中在一处。
   */
  tokenBudget?: number;
  recursive?: boolean;
  depth?: number;
  constant?: boolean;
  /** 主/次关键词组合：0=AND ANY（缺省）、1=NOT ALL、2=NOT ANY、3=AND ALL。 */
  selectiveLogic?: SelectiveLogic;
  /** 命中内容不再参与二次匹配（ST `excludeRecursion`）。 */
  excludeRecursion?: boolean;
  /** 不被二次匹配命中（ST `preventRecursion`），直接命中不受限。 */
  preventRecursion?: boolean;
  /** 前 N 个历史轮次不参与**递归**匹配（直接命中不受限）。 */
  delayUntilRecursion?: number;
  /** 同组最多注入一条。 */
  group?: string;
  /** 组内权重（确定性哈希抽取）；缺省时整组按优先级取最高。 */
  groupWeight?: number;
  /** 命中后 N 轮内继续注入（`reason:'sticky'`）。 */
  sticky?: number;
  /** 命中后 N 轮内不再命中。 */
  cooldown?: number;
  /** 总轮次 < N 时不参与。 */
  delay?: number;
}

export interface ScanBook {
  id: string;
  name?: string;
  enabled?: boolean;
  entries: readonly ScanEntry[];
}

export interface ScanMessage {
  role: string;
  content: string;
}

export interface ScanOptions {
  books: readonly ScanBook[];
  /** 历史消息，最近的在后（与界面显示顺序一致）。 */
  messages: readonly ScanMessage[];
  /** 默认扫描深度（条目的 depth 为 0 时用）：只看最近这么多条消息。 */
  scanDepth?: number;
  /** 递归轮数上限（防止 A 触发 B、B 又触发 A 时无限循环）。 */
  maxRecursion?: number;
  /** 字符预算（对中文来说约等于 token 量级；宁可粗一点，也不要静默超预算）。 */
  budgetChars?: number;
  /** 额外参与匹配的文本：通常是"用户正在输入但还没发出去"的那句话。 */
  extraText?: string;
  /**
   * 角色名键（ST 的 `\x01` 角色名键，B9）：以 `\x01` 拼在扫描文本最前面。
   * 至少传成员角色名；场景/物品名不自动加入（避免改变既有命中语义）。
   */
  names?: readonly string[];
}

/** `sticky` 是"命中后继续注入"；其余是关键词/常量/递归来源。 */
export type MatchReason = 'constant' | 'keyword' | 'recursive' | 'sticky';

export interface ScoredEntry {
  bookId: string;
  bookName: string;
  entryId: string;
  content: string;
  order: number;
  matchedKeys: string[];
  reason: MatchReason;
}

export interface ScanResult {
  matched: ScoredEntry[];
  /** 命中但被全局预算挤掉的条目（按同样的顺序）。 */
  dropped: ScoredEntry[];
  /** 因 group 互斥 / cooldown / delay 而没注入的命中条数（不静默）。 */
  suppressed: number;
  charsUsed: number;
  /** 实际扫了几轮（1 = 只有直接命中）。 */
  rounds: number;
}

const DEFAULTS = { scanDepth: 4, maxRecursion: 3, budgetChars: 1200 };

interface Candidate {
  bookId: string;
  bookName: string;
  entry: ScanEntry;
  order: number;
}
/** FNV-1a：跨设备一致的整数哈希（组权重抽取用，禁止 Math.random）。 */
function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 命中哪些关键词（返回值用于界面上解释"为什么注入它"）。 */
function matchKeys(haystack: string, keys: readonly string[], caseSensitive: boolean, matchWholeWords: boolean): string[] {
  const hits: string[] = [];
  const text = caseSensitive ? haystack : haystack.toLowerCase();
  for (const key of keys) {
    const needle = key.trim();
    if (needle === '') continue;
    const found = caseSensitive ? needle : needle.toLowerCase();
    const hit = matchWholeWords && isAsciiWord(found) ? includesWholeWord(text, found) : text.includes(found);
    if (hit) hits.push(needle);
  }
  return hits;
}

/** ASCII 词（字母/数字/下划线）：只有这种关键词受整词匹配影响；CJK 永远是子串。 */
function isAsciiWord(value: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(value);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/** 整词命中：`bell` 不能命中 `umbrella`；两侧必须是词边界。 */
function includesWholeWord(text: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? undefined : text[index - 1];
    const after = text[index + needle.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = index + 1;
  }
}

/** 主/次关键词是否命中 + 命中键（selectiveLogic 的四种组合）。 */
function matchEntry(entry: ScanEntry, haystack: string): { hit: boolean; keys: string[] } {
  const caseSensitive = entry.caseSensitive === true;
  const whole = entry.matchWholeWords === true;
  const primary = matchKeys(haystack, entry.keys ?? [], caseSensitive, whole);
  if (primary.length === 0) return { hit: false, keys: [] };
  const secondary = entry.secondaryKeys ?? [];
  // 没有次级关键词时，四种 selectiveLogic 都等价于"只看主键"（与 ST 一致）
  if (secondary.length === 0) return { hit: true, keys: primary };
  const secondaryHits = matchKeys(haystack, secondary, caseSensitive, whole);
  const logic = entry.selectiveLogic ?? 0;
  const pass =
    logic === 1
      ? secondaryHits.length !== secondary.length // NOT ALL
      : logic === 2
        ? secondaryHits.length === 0 // NOT ANY
        : logic === 3
          ? secondaryHits.length === secondary.length // AND ALL
          : secondaryHits.length > 0; // AND ANY（0/缺省）
  return { hit: pass, keys: [...primary, ...secondaryHits] };
}

/** 取某个历史前缀（`upto` 条）按 entry.depth 截出的扫描文本；只有当前轮才带 `extraText` / 角色名前缀。 */
function textAt(messages: readonly ScanMessage[], entry: ScanEntry, upto: number, scanDepth: number, extraText: string, names: readonly string[]): string {
  const count = (entry.depth ?? 0) > 0 ? (entry.depth as number) : scanDepth;
  const slice = messages.slice(Math.max(0, upto - count), upto).map((message) => message.content);
  if (upto === messages.length && extraText !== '') slice.push(extraText);
  const prefix = names.length === 0 ? '' : `${names.join('\u0001')}\u0001`;
  return `${prefix}${slice.join('\n')}`;
}

/**
 * 过去轮次里最后一条直接命中的轮次（1 起）。
 * **按每轮最后一条消息判定**（不看 depth 窗口）：否则关键词一直在窗口里时，cooldown 永远刷新。
 * 只在 sticky/cooldown 需要时才扫。
 */
function lastHitTurn(messages: readonly ScanMessage[], entry: ScanEntry, turn: number, lookback: number): number | undefined {
  let last: number | undefined;
  for (let upto = Math.max(1, turn - lookback); upto < turn; upto += 1) {
    const content = messages[upto - 1]?.content ?? '';
    if (matchEntry(entry, content).hit) last = upto;
  }
  return last;
}

/** 同组互斥：留一条（有权重按确定性哈希；全无权重按优先级/entryId）。 */
function applyGroups(entries: readonly ScoredEntry[], groupOf: (entry: ScoredEntry) => Candidate | undefined, seed: string): { kept: ScoredEntry[]; dropped: ScoredEntry[] } {
  const grouped = new Map<string, ScoredEntry[]>();
  const kept: ScoredEntry[] = [];
  const dropped: ScoredEntry[] = [];
  for (const entry of entries) {
    const group = (groupOf(entry)?.entry.group ?? '').trim();
    if (group === '') {
      kept.push(entry);
      continue;
    }
    const list = grouped.get(group);
    if (list === undefined) grouped.set(group, [entry]);
    else list.push(entry);
  }
  for (const [group, list] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (list.length === 1) {
      kept.push(list[0] as ScoredEntry);
      continue;
    }
    const sorted = [...list].sort((a, b) => a.entryId.localeCompare(b.entryId));
    const weighted = sorted.map((entry) => {
      const raw = groupOf(entry)?.entry.groupWeight;
      return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
    });
    let winner: ScoredEntry;
    if (weighted.every((weight) => weight === undefined)) {
      // 没有权重：按优先级（order 越小越优先），再按 id 定序
      winner = [...sorted].sort((a, b) => a.order - b.order || a.entryId.localeCompare(b.entryId))[0] as ScoredEntry;
    } else {
      const total = weighted.reduce<number>((sum, weight) => sum + (weight ?? 1), 0);
      let pick = stableHash(`${group}|${seed}`) % total;
      winner = sorted[sorted.length - 1] as ScoredEntry;
      for (let index = 0; index < sorted.length; index += 1) {
        pick -= weighted[index] ?? 1;
        if (pick < 0) {
          winner = sorted[index] as ScoredEntry;
          break;
        }
      }
    }
    kept.push(winner);
    dropped.push(...sorted.filter((entry) => entry !== winner));
  }
  return { kept, dropped };
}

export function scanLore(options: ScanOptions): ScanResult {
  const scanDepth = options.scanDepth ?? DEFAULTS.scanDepth;
  const maxRecursion = options.maxRecursion ?? DEFAULTS.maxRecursion;
  const budgetChars = options.budgetChars ?? DEFAULTS.budgetChars;
  const messages = options.messages;
  const turn = messages.length;
  const extraText = options.extraText ?? '';
  const names = options.names ?? [];

  const candidates: Candidate[] = [];
  for (const book of options.books) {
    if (book.enabled === false) continue;
    for (const entry of book.entries) {
      if (entry.enabled === false) continue;
      if (entry.content === '') continue;
      candidates.push({ bookId: book.id, bookName: book.name ?? '', entry, order: entry.order ?? 100 });
    }
  }
  const byKey = new Map(candidates.map((candidate) => [`${candidate.bookId}\u0000${candidate.entry.id}`, candidate]));

  // 轮次相关的拦截（delay/cooldown）与直接命中历史，只依赖输入，与递归轮无关 → 先算一次。
  const blocked = new Set<string>();
  const lastHitByKey = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.bookId}\u0000${candidate.entry.id}`;
    const entry = candidate.entry;
    if (entry.delay !== undefined && entry.delay > 0 && turn < entry.delay) {
      blocked.add(key);
      continue;
    }
    if (entry.cooldown !== undefined || entry.sticky !== undefined) {
      const lookback = Math.max(entry.cooldown ?? 0, entry.sticky ?? 0) + 1;
      const last = lastHitTurn(messages, entry, turn, lookback);
      if (last !== undefined) {
        lastHitByKey.set(key, last);
        if (entry.cooldown !== undefined && entry.cooldown > 0 && turn - last <= entry.cooldown) blocked.add(key);
      }
    }
  }

  const matched = new Map<string, ScoredEntry>();
  const extraBuffer: string[] = [];
  let suppressed = blocked.size;
  let rounds = 0;

  for (let round = 0; round < Math.max(1, maxRecursion); round += 1) {
    rounds = round + 1;
    const buffer = [...extraBuffer, extraText].join('\n');
    let addedThisRound = 0;

    for (const candidate of candidates) {
      const key = `${candidate.bookId}\u0000${candidate.entry.id}`;
      if (matched.has(key) || blocked.has(key)) continue;
      const entry = candidate.entry;
      // 递归变体：只有二次匹配（round>0）受限，直接命中永远有效
      if (round > 0 && entry.preventRecursion === true) continue;
      if (round > 0 && entry.delayUntilRecursion !== undefined && turn <= entry.delayUntilRecursion) continue;

      if (entry.constant === true) {
        matched.set(key, {
          bookId: candidate.bookId, bookName: candidate.bookName, entryId: entry.id,
          content: entry.content, order: candidate.order, matchedKeys: [], reason: 'constant',
        });
        addedThisRound += 1;
        continue;
      }

      // 第一轮：只看当前窗口；之后每轮把命中的条目正文也算进来
      const current = textAt(messages, entry, turn, scanDepth, extraText, names);
      const haystack = round === 0 ? current : `${current}\n${buffer}`;
      const result = matchEntry(entry, haystack);
      if (result.hit) {
        matched.set(key, {
          bookId: candidate.bookId, bookName: candidate.bookName, entryId: entry.id,
          content: entry.content, order: candidate.order, matchedKeys: result.keys,
          reason: round === 0 ? 'keyword' : 'recursive',
        });
        addedThisRound += 1;
        continue;
      }
      // sticky：上次直接命中后 N 轮内继续注入（没有关键词命中也照常注入）
      const lastHit = lastHitByKey.get(key);
      if (round === 0 && entry.sticky !== undefined && entry.sticky > 0 && lastHit !== undefined && turn - lastHit <= entry.sticky) {
        matched.set(key, {
          bookId: candidate.bookId, bookName: candidate.bookName, entryId: entry.id,
          content: entry.content, order: candidate.order, matchedKeys: [], reason: 'sticky',
        });
        addedThisRound += 1;
      }
    }

    // 递归：把这一轮命中的、允许递归的条目正文加入下一轮的匹配文本
    if (addedThisRound === 0) break;
    for (const entry of matched.values()) {
      const candidate = byKey.get(`${entry.bookId}\u0000${entry.entryId}`);
      if (candidate === undefined) continue;
      if (candidate.entry.recursive === false) continue;
      if (candidate.entry.excludeRecursion === true) continue;
      if (round === 0 && entry.reason === 'keyword') extraBuffer.push(entry.content);
      else if (round > 0) extraBuffer.push(entry.content);
    }
    if (extraBuffer.length === 0) break;
  }

  const ordered = [...matched.values()].sort(
    (a, b) => a.order - b.order || a.bookId.localeCompare(b.bookId) || a.entryId.localeCompare(b.entryId),
  );
  const seed = `${turn}|${messages[messages.length - 1]?.content ?? ''}|${extraText}`;
  const grouped = applyGroups(ordered, (entry) => byKey.get(`${entry.bookId}\u0000${entry.entryId}`), seed);
  suppressed += grouped.dropped.length;

  const kept: ScoredEntry[] = [];
  const dropped: ScoredEntry[] = [];
  let charsUsed = 0;
  for (const entry of grouped.kept.sort((a, b) => a.order - b.order || a.bookId.localeCompare(b.bookId) || a.entryId.localeCompare(b.entryId))) {
    if (charsUsed + entry.content.length <= budgetChars) {
      kept.push(entry);
      charsUsed += entry.content.length;
    } else {
      dropped.push(entry);
    }
  }

  return { matched: kept, dropped, suppressed, charsUsed, rounds };
}

/** 把命中的条目拼成注入用的文本块（顺序即最终顺序）。 */
export function formatLoreBlock(entries: readonly ScoredEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((entry) => entry.content.trim()).join('\n');
}
