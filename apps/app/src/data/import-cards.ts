/**
 * 酒馆（SillyTavern）导入 → 卡片模型的**纯映射**（ADR-0011 / §15）。
 *
 * 分工：`packages/importer` 只负责"字节 → Imported*"；这里决定每个字段的去处：
 *  - 能映射的进 `CharacterCard` / `LoreCard` / `WorldPackManifest`；
 *  - 酒馆有、我们没有的**成品文本**（scenario / 开场白 / 示例对话）转存为 `CompatStashEntry`，
 *    不塞回卡片（那样会造出两个真相），也不静默丢；
 *  - 确实没有承载的字段（`depth_prompt`、`extensions` 的值、未映射字段）记进 `discarded`，
 *    同时由调用方写入 `card.compat.discarded_fields` 留审计。
 *
 * 纯函数：不写仓储、不碰 React；`now` / `id` 都由调用方传入，测试可完全确定。
 */

import { ulid } from '../../../../packages/oplog/src/index.ts';
import type {
  CharacterCard,
  CompatInfo,
  CompatStashEntry,
  ExampleDialogue,
  LoreCard,
  PromptFragments,
  WorldPackManifest,
} from '../../../../packages/cards/src/index.ts';
import type { ImportedCharacter, ImportedLorebook } from '../../../../packages/importer/src/index.ts';

export interface ImportPlan {
  card: CharacterCard;
  /** 需写入的兼容草稿（scenario / 开场白），id 约定与迁移一致：`stash-scenario-<cardId>` / `stash-opening-<cardId>` */
  stash: CompatStashEntry[];
  /** 角色卡内嵌世界书：典籍卡 + 世界包（包名 `<角色名> 的世界书`；卡片 refs 指向角色 id） */
  loreCards: LoreCard[];
  pack?: WorldPackManifest;
  /** 给用户看的提示（哪些字段丢弃/转存/Agent 可补全） */
  notes: string[];
  /** 被丢弃的字段名（记入 card.compat.discarded_fields） */
  discarded: string[];
}

/** 开场白草稿里首段与备选之间的分隔符：与 `migrate-cards.ts` / `character-compat.ts` 完全一致。 */
const OPENING_SEPARATOR = '\n\n---\n\n';

/** 酒馆 `mes_example` 的分组标记：不是正文，不能当成一句对白。 */
const START_MARKER = /^<START>$/i;

/** 角色前缀（与 `migrate-cards.ts` 的解析规则保持一致）。 */
const ROLE_PREFIX = /^\s*(?:\{\{\s*(user|char|assistant|bot)\s*\}\}\s*[:：]?|<\s*(user|char|assistant|bot)\s*>\s*[:：]?|(?:user|assistant|char|bot)\s*[:：])\s*/i;

interface ExampleMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ParsedExamples {
  examples: ExampleDialogue[];
  /** 结构不可靠时保留原文（叫调用方转存为 stash，不猜、不丢）。 */
  raw?: string;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim() !== '');
  return line === undefined ? '' : line.trim();
}

/** 旧 personality 是整段文本：按行/逗号切成 traits（与迁移规则一致）。 */
function splitTraits(personality: string): string[] {
  return personality
    .split(/\r?\n|[,，、]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function cleaned(items: readonly string[]): string[] {
  return items.map((item) => item.trim()).filter((item) => item !== '');
}

/**
 * `mes_example` → `examples[]`。三种形态（与任务约定一致）：
 *  - 每行都带角色前缀（`{{user}}:` / `{{char}}:` / `user:`…）→ 多轮结构；
 *  - 全都不带前缀 → 每行一条 assistant（没有依据猜说话人）；
 *  - 混合 → 仍按每行 assistant 导入，同时把原文交给调用方转存 stash。
 * `<START>` 是分组标记，先剔除，不参与对白。
 */
function parseExamples(id: string, text: string): ParsedExamples {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !START_MARKER.test(line));
  if (lines.length === 0) return { examples: [] };

  const paired = lines.map((line): ExampleMessage | undefined => {
    const match = ROLE_PREFIX.exec(line);
    if (match === null) return undefined;
    const rawRole = (match[1] ?? match[2] ?? match[3] ?? '').toLowerCase();
    const content = line.slice(match[0].length).trim();
    if (content === '') return undefined;
    return { role: rawRole === 'user' ? 'user' : 'assistant', content };
  });
  const structured = paired.filter((message): message is ExampleMessage => message !== undefined);
  if (structured.length === lines.length) {
    return { examples: [{ id, messages: structured }] };
  }
  const assistantOnly: ExampleMessage[] = lines.map((content) => ({ role: 'assistant', content }));
  return {
    examples: [{ id, messages: assistantOnly }],
    ...(structured.length === 0 ? {} : { raw: text }),
  };
}

/** 开场白：`first_mes` + 备选 + 群聊专用（都属"开场"这一类），保留原文与顺序。 */
function greetingList(input: ImportedCharacter): string[] {
  return cleaned([input.firstMessage, ...(input.alternateGreetings ?? []), ...(input.groupOnlyGreetings ?? [])]);
}

/** 没有承载、只能丢弃的字段：extensions 的键、depth_prompt、以及解析器上报的未映射字段。 */
function discardedOf(input: ImportedCharacter): string[] {
  const out = new Set<string>();
  for (const key of input.extensionKeys ?? []) out.add(key);
  if ((input.depthPrompt ?? '').trim() !== '') out.add('depth_prompt');
  for (const field of input.unmappedFields ?? []) out.add(field);
  return [...out];
}

function importedFromOf(spec: string): string {
  const lower = spec.toLowerCase();
  if (lower.includes('v3')) return 'sillytavern/v3';
  if (lower.includes('v2')) return 'sillytavern/v2';
  return 'sillytavern/legacy';
}

function metaDescriptionOf(input: ImportedCharacter): string {
  const notes = (input.creatorNotes ?? '').trim();
  if (notes !== '') return notes;
  const line = firstLine(input.description);
  return line !== '' ? line : '从酒馆导入';
}

function promptsOf(input: ImportedCharacter): PromptFragments | undefined {
  const systemExtra = input.systemPrompt.trim();
  const postHistory = (input.postHistoryInstructions ?? '').trim();
  const prompts: PromptFragments = {
    ...(systemExtra === '' ? {} : { system_extra: systemExtra }),
    ...(postHistory === '' ? {} : { post_history_instructions: postHistory }),
  };
  return Object.keys(prompts).length === 0 ? undefined : prompts;
}

function stashEntriesOf(
  input: ImportedCharacter,
  cardId: string,
  now: number,
  parsed: ParsedExamples,
): CompatStashEntry[] {
  const out: CompatStashEntry[] = [];
  const base = { schema: 'stash/v1', character_id: cardId, created_at: now } as const;
  if (input.scenario.trim() !== '') {
    out.push({
      ...base,
      id: `stash-scenario-${cardId}`,
      kind: 'scenario',
      text: input.scenario,
      source: 'sillytavern/v2:scenario',
    });
  }
  const greetings = greetingList(input);
  if (greetings.length > 0) {
    out.push({
      ...base,
      id: `stash-opening-${cardId}`,
      kind: 'opening',
      text: greetings.join(OPENING_SEPARATOR),
      source: 'sillytavern/v2:first_mes',
    });
  }
  if (parsed.raw !== undefined) {
    out.push({
      ...base,
      id: `stash-other-${cardId}`,
      kind: 'other',
      text: parsed.raw,
      source: 'sillytavern/v2:mes_example',
    });
  }
  return out;
}

/** `character_book` 的包名按任务约定固定为 `<角色名> 的世界书`（不沿用书里的自定义名）。 */
function embeddedPackName(name: string): string {
  return `${name} 的世界书`;
}

function loreCardOf(
  entry: ImportedLorebook['entries'][number],
  input: { id: string; order: number; depth: number; characterId?: string },
): LoreCard {
  const keys = cleaned(entry.keys);
  const name = entry.name.trim() !== '' ? entry.name.trim() : (keys[0] ?? '条目');
  const firstContentLine = entry.content.split(/\r?\n/).find((line) => line.trim() !== '')?.trim() ?? '';
  return {
    card_type: 'lore',
    meta: {
      id: input.id,
      schema: 'lore/v1',
      name,
      version: '1.0.0',
      language: 'zh-CN',
      rating: 'general',
      // 简介取注释；没有注释就用正文首行（都是作者原文，不是编的）
      description: entry.name.trim() !== '' ? entry.name.trim() : firstContentLine !== '' ? firstContentLine : '从酒馆导入',
    },
    kind: 'other',
    content: entry.content,
    keys,
    ...(entry.secondaryKeys.length === 0 ? {} : { secondary_keys: cleaned(entry.secondaryKeys) }),
    ...(input.characterId === undefined
      ? {}
      : { refs: [{ target: input.characterId, type: 'related' }] }),
    trigger: {
      constant: entry.constant,
      priority: input.order,
      recursive: entry.recursive ?? true,
      // depth=0 表示默认窗口：省略字段（0 与"不注入"是两种语义，不能混）
      ...(input.depth === 0 ? {} : { depth: input.depth }),
    },
    // 条目级启停属于作者的设定语义（LoreCard 已有该字段）：关掉的照常导入，只是不参与扫描
    ...(entry.enabled ? {} : { enabled: false }),
  };
}

/**
 * 独立世界书（`kind: 'lorebook'` 或角色卡内嵌 worldbook）→ 世界包 + 典籍卡。
 *
 * 条目 `enabled === false` 映射到 `LoreCard.enabled`（条目级启停，属于作者设定语义）；
 * 库级启停（`card.library`）是使用者的库状态，导入不碰。
 */
export function planLorebookImport(
  input: ImportedLorebook,
  options: { now: number; id?: string; characterId?: string },
): { pack: WorldPackManifest; cards: LoreCard[]; notes: string[] } {
  const packId = options.id ?? ulid();
  const packName = input.name.trim() === '' ? '导入的世界书' : input.name.trim();
  const notes: string[] = [];
  const cards: LoreCard[] = [];
  let emptyCount = 0;
  let disabledCount = 0;
  let keylessCount = 0;

  input.entries.forEach((entry, index) => {
    const content = entry.content.trim();
    if (content === '') {
      emptyCount += 1;
      return;
    }
    if (!entry.enabled) disabledCount += 1;
    const keys = cleaned(entry.keys);
    if (keys.length === 0 && !entry.constant) keylessCount += 1;
    cards.push(
      loreCardOf(entry, {
        id: `${packId}-lore-${index + 1}`,
        order: entry.order ?? index * 10,
        depth: entry.depth !== undefined && entry.depth > 0 ? entry.depth : 0,
        ...(options.characterId === undefined ? {} : { characterId: options.characterId }),
      }),
    );
  });

  const pack: WorldPackManifest = {
    schema: 'worldpack/v1',
    id: packId,
    name: packName,
    version: '1.0.0',
    description: input.description,
    language: 'zh-CN',
    card_ids: cards.map((card) => card.meta.id),
    created_at: options.now,
    updated_at: options.now,
  };

  notes.push(`世界书「${packName}」：${cards.length} 条已转换为典籍卡${emptyCount === 0 ? '' : `，${emptyCount} 条空内容条目已跳过`}`);
  if (disabledCount > 0) {
    notes.push(`${disabledCount} 条条目在酒馆里是关闭的：已按卡片字段 enabled:false 导入（保留语义，不参与扫描）`);
  }
  if (keylessCount > 0) {
    notes.push(`${keylessCount} 条条目既没有关键词也不是常驻，保存时会被校验拦住（需补关键词或改为常驻）`);
  }
  return { pack, cards, notes };
}

/** 角色卡：酒馆字段 → 卡片 / 草稿 / 丢弃清单。 */
export function planCharacterImport(input: ImportedCharacter, options: { now: number; id?: string }): ImportPlan {
  const cardId = options.id ?? ulid();
  const name = input.name.trim();
  const parsed =
    input.exampleDialogue.trim() === '' ? { examples: [] as ExampleDialogue[] } : parseExamples(`${cardId}-example-1`, input.exampleDialogue);
  const discarded = discardedOf(input);
  const compat: CompatInfo = {
    imported_from: importedFromOf(input.spec),
    imported_at: options.now,
    ...(discarded.length === 0 ? {} : { discarded_fields: discarded }),
  };
  const prompts = promptsOf(input);
  const tags = cleaned(input.tags ?? []);
  const author = (input.creator ?? '').trim();
  const card: CharacterCard = {
    card_type: 'character',
    meta: {
      id: cardId,
      schema: 'rolecard/v1',
      name,
      version: (input.characterVersion ?? '').trim() === '' ? '1.0.0' : (input.characterVersion ?? '').trim(),
      language: 'zh-CN',
      rating: 'general',
      description: metaDescriptionOf(input),
      ...(tags.length === 0 ? {} : { tags }),
      ...(author === '' ? {} : { author }),
      created_at: options.now,
      updated_at: options.now,
    },
    identity: { name, background: input.description },
    persona: {
      summary: firstLine(input.personality),
      traits: splitTraits(input.personality),
      // 酒馆没有防幻觉边界：留空，校验器只报 warning，作者/Agent 可补全
      knowledge_boundary: '',
      ability_boundary: '',
    },
    speech: { style: '' },
    ...(parsed.examples.length === 0 ? {} : { examples: parsed.examples }),
    ...(prompts === undefined ? {} : { prompts }),
    compat,
  };

  const stash = stashEntriesOf(input, cardId, options.now, parsed);
  const notes: string[] = [];
  if (input.scenario.trim() !== '') notes.push('scenario 已转存为本地推荐处境草稿（卡片不包含场景字段）');
  const greetings = greetingList(input);
  if (greetings.length > 0) notes.push(`开场白 ${greetings.length} 条已转存为本地开场草稿（卡片不包含开场字段）`);
  if (parsed.raw !== undefined) {
    notes.push('mes_example 有一行没有角色前缀：已按每行 assistant 导入，原文另存为草稿（未猜说话人）');
  }
  if (input.personality.trim() === '') {
    notes.push('personality 为空：persona.summary / traits 为空，保存时会被校验拦住（需补全后再导入）');
  }
  notes.push('knowledge_boundary / ability_boundary 留空，可由作者或 Agent 补全');
  notes.push('speech.style 留空，可由 Agent 从描述里提取');
  if (discarded.length > 0) notes.push(`已丢弃字段（无对应承载，仅留审计）：${discarded.join('、')}`);

  let loreCards: LoreCard[] = [];
  let pack: WorldPackManifest | undefined;
  if (input.lorebook !== undefined) {
    const lorePlan = planLorebookImport(
      { ...input.lorebook, name: embeddedPackName(name) },
      {
        now: options.now,
        // 包 id 跟随角色卡的显式 id，导入才算确定（不传 id 时各自 ulid）
        ...(options.id === undefined ? {} : { id: `${cardId}-worldbook` }),
        characterId: cardId,
      },
    );
    loreCards = lorePlan.cards;
    pack = lorePlan.pack;
    notes.push(...lorePlan.notes);
  }

  return { card, stash, loreCards, ...(pack === undefined ? {} : { pack }), notes, discarded };
}
