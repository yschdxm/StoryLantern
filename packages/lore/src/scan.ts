/**
 * 世界书扫描：**纯函数**，零依赖，因此可以被单测穷举、也能在任意端复用。
 *
 * 语义参考 SillyTavern 的世界书（那套心智模型用户已经熟悉），但只保留真正有用的部分，
 * 并把每条规则都写成能被测试断言的形式：
 *
 *  - **关键词**：主关键词命中任意一个即可；次级关键词非空时要求**也**命中至少一个。
 *  - **大小写**：默认不敏感；`caseSensitive` 打开后按原文比较。
 *  - **深度窗口**：`depth = N` 表示只看最近 N 条消息；`depth = 0` 用调用方给的默认深度。
 *    正在输入的那句话（`extraText`）永远参与匹配——否则"打字时提到某个设定"不会触发。
 *  - **常量**：`constant = true` 不看关键词，只要书被激活就注入。
 *  - **递归**：命中条目的正文会追加进扫描文本，再扫一轮（`recursive` 为 false 的条目内容不参与）。
 *  - **预算**：按 `order` 升序（小的先放）贪心放入，放不下的记为 `dropped`，界面可以提示。
 *
 * 输出**与输入顺序无关**（同分按 bookId/entryId 排序），因此两台设备、两次调用都得到同样的注入，
 * 这既是可解释性的前提，也是同步一致性的前提。
 */

export interface ScanEntry {
  id: string;
  keys: readonly string[];
  secondaryKeys?: readonly string[];
  content: string;
  enabled?: boolean;
  order?: number;
  caseSensitive?: boolean;
  recursive?: boolean;
  depth?: number;
  constant?: boolean;
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
}

export type MatchReason = 'constant' | 'keyword' | 'recursive';

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
  /** 命中但被预算挤掉的条目（按同样的顺序）。 */
  dropped: ScoredEntry[];
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

export function scanLore(options: ScanOptions): ScanResult {
  const scanDepth = options.scanDepth ?? DEFAULTS.scanDepth;
  const maxRecursion = options.maxRecursion ?? DEFAULTS.maxRecursion;
  const budgetChars = options.budgetChars ?? DEFAULTS.budgetChars;

  const candidates: Candidate[] = [];
  for (const book of options.books) {
    if (book.enabled === false) continue;
    for (const entry of book.entries) {
      if (entry.enabled === false) continue;
      if (entry.content === '') continue;
      candidates.push({ bookId: book.id, bookName: book.name ?? '', entry, order: entry.order ?? 100 });
    }
  }

  // 深度窗口文本：每条消息单独留一份，方便按 depth 切片
  const history = options.messages.map((message) => message.content);
  const tail = (depth: number): string => {
    const count = depth > 0 ? depth : scanDepth;
    return [...history.slice(-count), options.extraText ?? ''].join('\n');
  };

  const matched = new Map<string, ScoredEntry>();
  const extraBuffer: string[] = [];
  let rounds = 0;

  for (let round = 0; round < Math.max(1, maxRecursion); round += 1) {
    rounds = round + 1;
    const buffer = [...extraBuffer, options.extraText ?? ''].join('\n');
    let addedThisRound = 0;

    for (const candidate of candidates) {
      const key = `${candidate.bookId}\u0000${candidate.entry.id}`;
      if (matched.has(key)) continue;
      const entry = candidate.entry;

      if (entry.constant === true) {
        matched.set(key, {
          bookId: candidate.bookId,
          bookName: candidate.bookName,
          entryId: entry.id,
          content: entry.content,
          order: candidate.order,
          matchedKeys: [],
          reason: 'constant',
        });
        addedThisRound += 1;
        continue;
      }

      // 第一轮：只看直接文本（历史窗口 + 正在输入）；之后每轮把命中内容也算进来
      const haystack = `${tail(entry.depth ?? 0)}\n${buffer}`;
      const hits = matchKeys(haystack, entry.keys ?? [], entry.caseSensitive === true);
      if (hits.length === 0) continue;

      const secondary = entry.secondaryKeys ?? [];
      if (secondary.length > 0) {
        const secondaryHits = matchKeys(haystack, secondary, entry.caseSensitive === true);
        if (secondaryHits.length === 0) continue;
        hits.push(...secondaryHits);
      }

      matched.set(key, {
        bookId: candidate.bookId,
        bookName: candidate.bookName,
        entryId: entry.id,
        content: entry.content,
        order: candidate.order,
        matchedKeys: hits,
        reason: round === 0 ? 'keyword' : 'recursive',
      });
      addedThisRound += 1;
    }

    // 递归：把这一轮命中的、允许递归的条目正文加入下一轮的匹配文本
    if (addedThisRound === 0) break;
    for (const entry of matched.values()) {
      const candidate = candidates.find((item) => item.bookId === entry.bookId && item.entry.id === entry.entryId);
      if (candidate === undefined) continue;
      if (candidate.entry.recursive === false) continue;
      if (round === 0 && entry.reason === 'keyword') extraBuffer.push(entry.content);
      else if (round > 0) extraBuffer.push(entry.content);
    }
    if (extraBuffer.length === 0) break;
  }

  const ordered = [...matched.values()].sort(
    (a, b) => a.order - b.order || a.bookId.localeCompare(b.bookId) || a.entryId.localeCompare(b.entryId),
  );

  const kept: ScoredEntry[] = [];
  const dropped: ScoredEntry[] = [];
  let charsUsed = 0;
  for (const entry of ordered) {
    if (charsUsed + entry.content.length <= budgetChars) {
      kept.push(entry);
      charsUsed += entry.content.length;
    } else {
      dropped.push(entry);
    }
  }

  return { matched: kept, dropped, charsUsed, rounds };
}

/** 命中哪些关键词（返回值用于界面上解释"为什么注入它"）。 */
function matchKeys(haystack: string, keys: readonly string[], caseSensitive: boolean): string[] {
  const hits: string[] = [];
  const text = caseSensitive ? haystack : haystack.toLowerCase();
  for (const key of keys) {
    const needle = key.trim();
    if (needle === '') continue;
    if (text.includes(caseSensitive ? needle : needle.toLowerCase())) hits.push(needle);
  }
  return hits;
}

/** 把命中的条目拼成注入用的文本块（顺序即最终顺序）。 */
export function formatLoreBlock(entries: readonly ScoredEntry[]): string {
  if (entries.length === 0) return '';
  return entries.map((entry) => entry.content.trim()).join('\n');
}
