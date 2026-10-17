import {
  HlcClock,
  cardUpsert,
  packUpsert,
  sessionSetup,
  stashUpsert,
  type CharacterRecord,
  type Hlc,
  type LoreEntryRecord,
  type LorebookRecord,
  type MaterializedState,
  type Op,
} from '../../../../packages/oplog/src/index.ts';
import type {
  CharacterCard,
  CompatStashEntry,
  ExampleDialogue,
  LoreCard,
  SessionSetup,
  WorldPackManifest,
} from '../../../../packages/cards/src/index.ts';
import { describeError } from './error-text.ts';

/**
 * 旧 op 模型（`character.*` / `lorebook.*` / `session.create`）→ 卡片模型（ADR-0011）。
 *
 * 三个必须钉死的性质：
 *  1. **确定性**：opId 是固定格式、HLC 取源记录、deviceId 恒为 `legacy-migration`，
 *     因此任何设备对同一份旧状态算出来的 op **逐字节一样**，同步时按 opId 幂等去重，
 *     不会因为"每台设备都迁移一次"而翻倍。
 *  2. **幂等**：只看"目标实体是否已存在（含墓碑）"。迁移 ops 应用后再跑一次必然返回 0 条。
 *  3. **纯函数**：不写盘、不依赖当前时间、不 import React —— 输入物化状态，输出待追加的 op。
 *
 * 已知语义缺口（迁移无法凭空补齐，最终报告里如实列出）：
 *  - 旧世界书/条目的 `enabled=false`：卡片没有包级/条目级开关。包照常迁移；
 *    条目用 `meta.tags` 标记 `legacy-disabled`，但**迁移后会被注入**。
 *  - 旧 `scenario` / 开场白不再是角色卡字段：成品文本进 `CompatStashEntry`（kind `scenario`/`opening`），
 *    卡片里不留旧字段（避免两个真相）。
 */

/** 迁移 op 的设备 id：固定值，保证跨设备逐字节一致。 */
export const LEGACY_MIGRATION_DEVICE = 'legacy-migration';

export interface LegacyToCardsResult {
  ops: Op[];
  cards: number;
  setups: number;
  packs: number;
  stash: number;
}

type OpBase = { deviceId: string; clock: HlcClock };

/** 按 id 排序：物化状态里 Record 的键序取决于 op 到达顺序，迁移必须与它无关。 */
function byId<T extends { id: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function mirror(hlc: Hlc): Hlc {
  return { t: hlc.t, c: hlc.c };
}

function stamp(hlc: Hlc, opId: string): { hlc: Hlc; opId: string } {
  return { hlc: mirror(hlc), opId };
}

// ---------------------------------------------------------------- 文本映射

/** 人设第一行：`persona.summary` 的旧数据来源。 */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== '');
  return line === undefined ? '' : line.trim();
}

/** 旧 `personality` 是整段文本：按行/逗号切成 traits（只去空，不猜作者意图）。 */
function splitTraits(personality: string): string[] {
  return personality
    .split(/\r?\n|[,，、]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

const ROLE_PREFIX = /^\s*(?:\{\{\s*(user|char|assistant|bot)\s*\}\}\s*[:：]?|<\s*(user|char|assistant|bot)\s*>\s*[:：]?|(?:user|assistant|char|bot)\s*[:：])\s*/i;

/**
 * 旧 `exampleDialogue` 是整块文本 → 一条结构化 `ExampleDialogue`。
 *
 * 只有两种情况敢落成结构：每行都带角色前缀（`{{user}}:` / `<char>:` / `user:` 等），
 * 或者**一行都没有**前缀（旧数据本来就是一整块示例，全按 assistant 放，不猜说话人）。
 * 混合形态说明结构不可靠：宁可不猜，返回原文由调用方放进 stash。
 */
function parseExamples(id: string, text: string): { examples: ExampleDialogue[]; unparsed?: string } {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return { examples: [] };

  const paired = lines.map((line) => {
    const match = ROLE_PREFIX.exec(line);
    if (match === null) return undefined;
    const rawRole = (match[1] ?? match[2] ?? match[3] ?? '').toLowerCase();
    const content = line.slice(match[0].length).trim();
    if (content === '') return undefined;
    return { role: rawRole === 'user' ? ('user' as const) : ('assistant' as const), content };
  });

  if (paired.every((message) => message !== undefined)) {
    return { examples: [{ id: `${id}-example-1`, messages: paired }] };
  }
  if (paired.every((message) => message === undefined)) {
    return { examples: [{ id: `${id}-example-1`, messages: lines.map((content) => ({ role: 'assistant' as const, content })) }] };
  }
  // 混合形态：结构不可靠，但**内容不能丢**。给模型的那份按"每行一条 assistant 示例"落进卡片，
  // 原文另外进 stash（保留可读的原始格式，供用户之后拆成结构化示例）。
  return {
    examples: [{ id: `${id}-example-1`, tags: ['legacy-unparsed'], messages: lines.map((content) => ({ role: 'assistant' as const, content })) }],
    unparsed: text,
  };
}

// ---------------------------------------------------------------- 实体映射

function characterCardOf(character: CharacterRecord, examples: readonly ExampleDialogue[]): CharacterCard {
  const description = character.description ?? '';
  const personality = character.personality ?? '';
  return {
    card_type: 'character',
    meta: {
      id: character.id,
      schema: 'rolecard/v1',
      name: character.name,
      version: '1.0.0',
      language: 'zh-CN',
      rating: 'general',
      description: description.trim() !== '' ? description : personality,
    },
    identity: { name: character.name, background: description },
    persona: {
      summary: firstLine(personality),
      traits: splitTraits(personality),
      // 有意的过渡态：卡片要求有这两个字段，旧数据没有。校验器只报 warning，保存不拦。
      knowledge_boundary: '',
      ability_boundary: '',
    },
    speech: { style: '' },
    ...(examples.length === 0 ? {} : { examples }),
  };
}

function stashEntriesOf(character: CharacterRecord): CompatStashEntry[] {
  const out: CompatStashEntry[] = [];
  const at = character.updatedHlc.t;
  const scenario = character.scenario ?? '';
  if (scenario.trim() !== '') {
    out.push({
      schema: 'stash/v1',
      id: `legacy-stash-scenario-${character.id}`,
      character_id: character.id,
      kind: 'scenario',
      text: scenario,
      source: 'legacy:character.scenario',
      created_at: at,
    });
  }

  const greetings = [character.firstMessage ?? '', ...(character.alternateGreetings ?? [])]
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (greetings.length > 0) {
    out.push({
      schema: 'stash/v1',
      id: `legacy-stash-opening-${character.id}`,
      character_id: character.id,
      kind: 'opening',
      // 第一条是主开场白；其余用醒目分隔符接在后面，原文不丢
      text: greetings.join('\n\n---\n\n'),
      source: 'legacy:character.firstMessage',
      created_at: at,
    });
  }

  // 示例对话结构不可靠时，原文进 stash（不编结构；卡片里 `examples` 留空）
  const exampleDialogue = (character.exampleDialogue ?? '').trim() === '' ? '' : (character.exampleDialogue ?? '');
  const parsed: { examples: ExampleDialogue[]; unparsed?: string } =
    exampleDialogue === '' ? { examples: [] } : parseExamples(character.id, exampleDialogue);
  if (parsed.unparsed !== undefined) {
    out.push({
      schema: 'stash/v1',
      id: `legacy-stash-other-${character.id}`,
      character_id: character.id,
      kind: 'other',
      text: parsed.unparsed,
      source: 'legacy:character.exampleDialogue',
      created_at: at,
    });
  }
  return out;
}

function loreCardOf(entry: LoreEntryRecord): LoreCard {
  const keys = [...entry.keys].filter((key) => key.trim() !== '');
  const comment = (entry.comment ?? '').trim();
  // 名字优先用第一个触发词：旧数据的 `comment` 里常放 provenance（"来源：<id> | ..."），
  // 拿它当名字会让列表全是哈希串（真机上看到过）。没有关键词时才退回 comment。
  const name = keys[0] ?? (comment !== '' ? comment : '条目');
  const firstContentLine = (entry.content ?? '').split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
  return {
    card_type: 'lore',
    meta: {
      id: entry.id,
      schema: 'lore/v1',
      name,
      version: '1.0.0',
      language: 'zh-CN',
      rating: 'general',
      // 简介取正文首行（作者原文）；正文为空才退回注释
      description: firstContentLine !== '' ? firstContentLine : comment,
      // 语义缺口：条目级 enabled 尚未进卡片模型（库级启停见 card.library）。标记出来，报告里如实说明。
      ...(entry.enabled ? {} : { tags: ['legacy-disabled'] }),
    },
    kind: 'other',
    content: entry.content,
    keys,
    secondary_keys: [...entry.secondaryKeys],
    trigger: {
      constant: entry.constant,
      priority: entry.order,
      recursive: entry.recursive,
      // depth=0 表示用默认窗口：省略字段，而不是写 0（0 是"不注入"的另一种语义）
      ...(entry.depth === 0 ? {} : { depth: entry.depth }),
    },
  };
}

function packOf(book: LorebookRecord, entries: readonly LoreEntryRecord[]): WorldPackManifest {
  return {
    schema: 'worldpack/v1',
    id: book.id,
    name: book.name,
    version: '1.0.0',
    description: book.description,
    language: 'zh-CN',
    card_ids: entries.map((entry) => entry.id),
  };
}

function liveEntriesOf(book: LorebookRecord): LoreEntryRecord[] {
  return byId(Object.values(book.entries).filter((entry) => entry.deleted === undefined));
}

// ---------------------------------------------------------------- 入口

export function migrateLegacyToCards(
  state: MaterializedState,
  options: { deviceId?: string } = {},
): LegacyToCardsResult {
  // 默认固定 deviceId：两台设备独立迁移得到的 op 必须逐字节一致，同步时才不会翻倍
  const deviceId = options.deviceId ?? LEGACY_MIGRATION_DEVICE;
  const clock = new HlcClock({ now: () => 0 });
  const base = (): OpBase => ({ deviceId, clock });
  const ops: Op[] = [];
  let cards = 0;
  let stash = 0;
  let packs = 0;
  let setups = 0;

  const characters = byId(Object.values(state.characters).filter((record) => record.deleted === undefined));
  const lorebooks = byId(Object.values(state.lorebooks).filter((record) => record.deleted === undefined));
  const sessions = byId(Object.values(state.sessions).filter((record) => record.deleted === undefined));

  // 1) 旧角色 → CharacterCard
  for (const character of characters) {
    if (state.cards[character.id] !== undefined) continue; // 已迁移过（含墓碑）
    const parsed: { examples: ExampleDialogue[]; unparsed?: string } =
      (character.exampleDialogue ?? '').trim() === ''
        ? { examples: [] }
        : parseExamples(character.id, character.exampleDialogue ?? '');
    ops.push(
      cardUpsert(
        base(),
        { card: characterCardOf(character, parsed.examples) },
        stamp(character.updatedHlc, `legacy-card-${character.id}`),
      ),
    );
    cards += 1;
  }

  // 2) 旧世界书条目 → LoreCard（所属书可能已经迁过，条目要独立判重）
  for (const book of lorebooks) {
    for (const entry of liveEntriesOf(book)) {
      if (state.cards[entry.id] !== undefined) continue;
      ops.push(
        cardUpsert(
          base(),
          { card: loreCardOf(entry) },
          stamp(entry.updatedHlc, `legacy-lore-${entry.id}`),
        ),
      );
      cards += 1;
    }
  }

  // 3) 旧成品文本 → CompatStashEntry
  for (const character of characters) {
    for (const entry of stashEntriesOf(character)) {
      if (state.stash[entry.id] !== undefined) continue; // 已迁移过（含墓碑）
      ops.push(stashUpsert(base(), { entry }, stamp(character.updatedHlc, entry.id)));
      stash += 1;
    }
  }

  // 4) 旧世界书 → WorldPackManifest（enabled=false 也迁移：卡片没有包级开关，报告里说明缺口）
  for (const book of lorebooks) {
    if (state.packs[book.id] !== undefined) continue;
    const entries = liveEntriesOf(book);
    ops.push(packUpsert(base(), { pack: packOf(book, entries) }, stamp(book.updatedHlc, `legacy-pack-${book.id}`)));
    packs += 1;
  }

  // 5) 旧会话 → SessionSetup（没有 characterId 的会话不生成：setup.characters 语义是 ≥1）
  for (const session of sessions) {
    if (state.setups[session.id] !== undefined) continue;
    const characterId = session.characterId;
    if (characterId === undefined) continue;
    const character = state.characters[characterId];
    if (character === undefined || character.deleted !== undefined) continue;
    const setup: SessionSetup = {
      characters: [characterId],
      // 旧 scenario 里真正属于"这一局"的部分；没有就从空串起（正文已在 stash，不丢）
      premise: (character.scenario ?? '').trim(),
      opening_mode: 'designated',
      opening_speaker: characterId,
      origin: 'card',
    };
    ops.push(sessionSetup(base(), { session_id: session.id, setup }, stamp(session.createdHlc, `legacy-setup-${session.id}`)));
    setups += 1;
  }

  return { ops, cards, setups, packs, stash };
}

/**
 * ready 阶段用：把迁移结果落盘，失败只回报原因（不抛）。
 *
 * 规则仍然全部住在纯函数 `migrateLegacyToCards` 里；这里只做"落盘 + 错误收敛"，
 * 因为 `op-repository.ready` 的职责是启动，不应该被一次迁移失败挡住。
 */
export async function migrateLegacyIntoLog(input: {
  state: MaterializedState;
  appendAndApply(ops: Op[]): Promise<void>;
}): Promise<{ ops: number; problem?: string }> {
  try {
    const result = migrateLegacyToCards(input.state);
    if (result.ops.length > 0) await input.appendAndApply(result.ops);
    return { ops: result.ops.length };
  } catch (cause) {
    return { ops: 0, problem: `卡片模型迁移失败：${describeError(cause)}` };
  }
}
