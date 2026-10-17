/**
 * 旧 `Character` 视图 ↔ 角色卡（`rolecard/v1`）的过渡兼容层（ADR-0011）。
 *
 * 这里只有纯映射与派生（op 写入仍只在 `op-repository.ts`）。卡片没有 scenario / 开场白
 * （它们属于会话开局配置）：读时从 `CompatStashEntry` 草稿补，写时进草稿而不是塞回卡片。
 */

import {
  isCardLibraryEnabled,
  listCards,
  liveCard,
  liveStash,
  ulid,
  type CardRecord,
  type CharacterRecord,
  type MaterializedState,
} from '../../../../packages/oplog/src/index.ts';
import type {
  CardAppearance,
  CardMeta,
  CharacterCard,
  CharacterIdentity,
  CompatStashEntry,
  Persona,
  PromptFragments,
  Rating,
  Speech,
} from '../../../../packages/cards/src/index.ts';
import { characterCardOfLegacy } from './card-fallback.ts';
import { characterView } from './op-views.ts';
import { DataError } from './repository.ts';
import type { Character, CharacterDraft, Session } from './types.ts';

/** 角色卡在列表里的投影：`card` 仍是权威文档。 */
export interface CharacterCardView {
  id: string;
  name: string;
  /** 列表/副标题用：persona.summary，或 identity.background 截断 */
  subtitle: string;
  card: CharacterCard;
  /** 库级启停（false = 退役/草稿） */
  enabled: boolean;
}

/**
 * 编辑器草稿：只包含**表单拥有的字段**。
 * `personalitySummary` 的第一行成为 `persona.summary`；显式给 `traits` 时优先于切分结果，
 * 这样"简介副标题"与"性格标签"可以是两个输入框而不互相覆盖。
 */
export interface CharacterCardDraft {
  id?: string | undefined;
  name: string;
  description?: string | undefined; // → meta.description
  background?: string | undefined; // → identity.background
  appearanceSummary?: string | undefined;
  personalitySummary?: string | undefined; // → persona.summary
  traits?: string[] | undefined; // 显式给出时优先
  goals?: string[] | undefined;
  fears?: string[] | undefined;
  taboos?: string[] | undefined;
  knowledgeBoundary?: string | undefined;
  abilityBoundary?: string | undefined;
  mood?: string | undefined;
  speechStyle?: string | undefined;
  tone?: string | undefined;
  vocabulary?: string[] | undefined;
  forbiddenWords?: string[] | undefined;
  narrationStyle?: string | undefined;
  exampleLines?: string[] | undefined;
  systemExtra?: string | undefined; // → prompts.system_extra
  roleplayRules?: string[] | undefined; // → prompts.roleplay_rules
  styleGuide?: string | undefined;
  brief?: string | undefined;
  tags?: string[] | undefined;
  rating?: Rating | undefined;
  language?: string | undefined;
  // 身份分区（设计文档 3 章；旧 6 字段之外、编辑器需要）
  occupation?: string | undefined;
  species?: string | undefined;
  age?: string | undefined;
  gender?: string | undefined;
  location?: string | undefined;
}

/** 编辑器表单字段更新器（子分区共享这一个签名）。 */
export type SetCharacterDraftField = <K extends keyof CharacterCardDraft>(key: K, value: CharacterCardDraft[K]) => void;

/** 状态变量的默认更新策略（ADR-0011：写 op 前由引擎夹取；编辑器在 form-state.tsx 使用）。 */
export const DEFAULT_STATE_UPDATE_POLICY = { allow_llm_patch: true, require_engine_validation: true } as const;

// ---------------------------------------------------------------- 小工具

const firstLine = (text: string): string => text.split(/\r?\n/).find((item) => item.trim() !== '')?.trim() ?? '';

const cleanList = (items: readonly string[]): string[] =>
  items.map((item) => item.trim()).filter((item) => item !== '');

const copyList = (items: readonly string[] | undefined): string[] | undefined =>
  items === undefined ? undefined : [...items];

const truncate = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

/** 旧 personality 的切分规则与 `card-fallback.ts` 保持一致。 */
const splitPersonality = (text: string): string[] => cleanList(text.split(/[\n\r、,，]/));

/** 只在有值时展开一个可选字段（`exactOptionalPropertyTypes` 下不能直接赋 undefined）。 */
function withField<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

// ---------------------------------------------------------------- 兼容草稿（scenario / 开场白）

/** 与 `migrate-cards.ts` 写进 stash 的格式保持一致。 */
const OPENING_SEPARATOR = '\n\n---\n\n';

/** 读某角色的某类草稿正文；多份时按 HLC 取最新（保存后不能还读到迁移时那条）。 */
function stashTextOf(state: MaterializedState, characterId: string, kind: CompatStashEntry['kind']): string | undefined {
  const entries = liveStash(state).filter(
    (record) => record.entry.character_id === characterId && record.entry.kind === kind,
  );
  entries.sort((a, b) => a.updatedHlc.t - b.updatedHlc.t || a.updatedHlc.c - b.updatedHlc.c || a.opId.localeCompare(b.opId));
  return entries[entries.length - 1]?.entry.text;
}

/** 开场草稿正文 → `{ firstMessage, alternateGreetings }`（首段 + 分隔后的其余段）。 */
function openingSourceOfText(text: string | undefined): { firstMessage: string; alternateGreetings: string[] } {
  if (text === undefined) return { firstMessage: '', alternateGreetings: [] };
  const parts = text.split(OPENING_SEPARATOR).map((part) => part.trim());
  return { firstMessage: parts[0] ?? '', alternateGreetings: parts.slice(1) };
}

/** 用兼容草稿补上旧字段（scenario / 开场白）；没有草稿就保持原样。 */
function withStashFields(state: MaterializedState, characterId: string, character: Character): Character {
  const scenario = stashTextOf(state, characterId, 'scenario');
  const opening = stashTextOf(state, characterId, 'opening');
  if (scenario === undefined && opening === undefined) return character;
  const source = openingSourceOfText(opening);
  return {
    ...character,
    ...withField('scenario', scenario),
    ...(opening === undefined ? {} : { firstMessage: source.firstMessage, alternateGreetings: source.alternateGreetings }),
  };
}

/**
 * 旧 `CharacterDraft` 里「卡片没有、但旧界面仍在用」的字段 → 兼容草稿。
 * 空的首段有意保留：读取时才能区分 `firstMessage` 与备选开场白。
 */
export function stashEntriesFromDraft(characterId: string, draft: CharacterDraft, createdAt: number): CompatStashEntry[] {
  const base = { schema: 'stash/v1', character_id: characterId, created_at: createdAt } as const;
  const out: CompatStashEntry[] = [];
  if (draft.scenario !== undefined) {
    out.push({ ...base, id: `stash-scenario-${characterId}`, kind: 'scenario', text: draft.scenario, source: 'character.scenario' });
  }
  if (draft.firstMessage !== undefined || draft.alternateGreetings !== undefined) {
    const text = [draft.firstMessage ?? '', ...(draft.alternateGreetings ?? [])].join(OPENING_SEPARATOR);
    out.push({ ...base, id: `stash-opening-${characterId}`, kind: 'opening', text, source: 'character.firstMessage' });
  }
  return out;
}

// ---------------------------------------------------------------- 卡片 → 旧视图

/** 卡片 → 列表视图。副标题优先用一句话人设，没有才退回背景截断。 */
export function viewOfCard(card: CharacterCard, enabled: boolean): CharacterCardView {
  const summary = card.persona.summary.trim();
  return {
    id: card.meta.id,
    name: card.identity.name,
    subtitle: summary !== '' ? summary : truncate(card.identity.background, 80),
    card,
    enabled,
  };
}

/**
 * 卡片 → 旧 `Character` 形状：description ← identity.background；personality ← summary+traits；
 * scenario/开场白在卡里没有 → 空（兼容草稿补）；systemPrompt ← prompts.system_extra。
 */
function characterOfCard(card: CharacterCard, createdAt: number, updatedAt: number): Character {
  const summary = card.persona.summary.trim();
  const traits = card.persona.traits.map((item) => item.trim()).filter((item) => item !== '' && item !== summary);
  return {
    id: card.meta.id,
    name: card.identity.name,
    description: card.identity.background,
    personality: [summary, ...traits].filter((item) => item !== '').join('\n'),
    scenario: '',
    firstMessage: '',
    exampleDialogue: '',
    systemPrompt: card.prompts?.system_extra ?? '',
    alternateGreetings: [],
    createdAt,
    updatedAt,
  };
}

function characterOfCardRecord(state: MaterializedState, record: CardRecord): Character | undefined {
  if (record.card.card_type !== 'character') return undefined;
  const legacy = state.characters[record.id];
  // 旧记录的 createdHlc 才是角色真正的创建时间；卡片记录的 HLC 是迁移 op 的时间
  const createdAt = legacy?.createdHlc.t ?? record.createdHlc.t;
  const updatedAt = Math.max(record.updatedHlc.t, legacy?.updatedHlc.t ?? 0);
  return withStashFields(state, record.id, characterOfCard(record.card, createdAt, updatedAt));
}

/** 兼容视图：卡片优先；卡片里没有、旧记录里有的角色再兜底。按最近更新倒序。 */
export function compatibleCharacters(state: MaterializedState): Character[] {
  const list: Character[] = [];
  const seen = new Set<string>();
  for (const record of listCards(state, 'character')) {
    if (record.card.card_type !== 'character') continue;
    const view = viewOfCard(record.card, isCardLibraryEnabled(state, record.id));
    const character = characterOfCardRecord(state, record);
    if (character === undefined) continue;
    seen.add(view.id);
    list.push(character);
  }
  for (const record of Object.values(state.characters)) {
    // 有卡片（含墓碑）时不再兜底：否则删掉迁移过的角色后，旧记录会把它"复活"
    if (record.deleted !== undefined || seen.has(record.id) || state.cards[record.id] !== undefined) continue;
    list.push(withStashFields(state, record.id, characterView(record)));
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/** 按 id 取兼容视图。 */
export function compatibleCharacter(state: MaterializedState, id: string): Character | undefined {
  const record = liveCard(state, id);
  if (record !== undefined && record.card.card_type === 'character') return characterOfCardRecord(state, record);
  // 卡片记录存在（含墓碑）时以卡片为准：墓碑不能被旧记录兜底复活
  if (state.cards[id] !== undefined) return undefined;
  const legacy = state.characters[id];
  return legacy === undefined || legacy.deleted !== undefined ? undefined : withStashFields(state, id, characterView(legacy));
}

/** 角色显示名：卡片优先，退回旧记录；都没有返回空串。 */
export function characterNameOf(state: MaterializedState, characterId: string): string {
  const record = liveCard(state, characterId);
  if (record !== undefined && record.card.card_type === 'character') return record.card.identity.name;
  const legacy = state.characters[characterId];
  return legacy === undefined || legacy.deleted !== undefined ? '' : legacy.name;
}

/** 会话视图补上"卡片角色"的名字（`sessionView` 只认旧记录）。 */
export function withSessionCharacterName(state: MaterializedState, view: Session): Session {
  const name = characterNameOf(state, view.characterId);
  return name === '' || name === view.characterName ? view : { ...view, characterName: name };
}

// ---------------------------------------------------------------- 旧域对象 / 草稿 → 卡片

/** 旧域对象 → 卡片视图：直接复用 `card-fallback.ts`，规则只有一份。 */
export function cardFromLegacyCharacter(character: Character): CharacterCard {
  return characterCardOfLegacy(character);
}

/** 生成稳定 id：默认 ULID（时间有序、跨设备唯一）；给前缀时带前缀便于人眼分辨。 */
export function newCardId(prefix?: string): string {
  const id = ulid();
  return prefix === undefined || prefix.trim() === '' ? id : `${prefix.trim()}-${id}`;
}

function appearanceOf(previous: CardAppearance | undefined, summary: string | undefined): CardAppearance | undefined {
  if (previous === undefined && summary === undefined) return undefined;
  return { ...previous, ...withField('summary', summary) };
}

function promptsOf(previous: PromptFragments | undefined, draft: CharacterCardDraft): PromptFragments | undefined {
  const next: PromptFragments = {
    ...previous,
    ...withField('system_extra', draft.systemExtra),
    ...withField('roleplay_rules', draft.roleplayRules === undefined ? undefined : cleanList(draft.roleplayRules)),
    ...withField('style_guide', draft.styleGuide),
  };
  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * 从编辑器草稿构建（或合并进已有卡）：**只覆盖表单拥有的字段**。
 * examples / state / rules / memory / presentation / visuals / refs / agent / compat /
 * extensions 以及 meta.author/license/cover 等原样保留：一次保存不能抹掉 Agent 或导入的内容。
 */
export function applyDraftToCard(existing: CharacterCard | undefined, draft: CharacterCardDraft): CharacterCard {
  const previous = existing;
  const id = draft.id ?? previous?.meta.id ?? newCardId();
  const name = draft.name.trim();
  const summary = draft.personalitySummary !== undefined ? firstLine(draft.personalitySummary) : (previous?.persona.summary ?? '');
  const traits =
    draft.traits !== undefined
      ? cleanList(draft.traits)
      : draft.personalitySummary !== undefined
        ? splitPersonality(draft.personalitySummary)
        : (copyList(previous?.persona.traits) ?? []);
  const meta: CardMeta = {
    ...previous?.meta,
    id,
    schema: previous?.meta.schema ?? 'rolecard/v1',
    name,
    version: previous?.meta.version ?? '1.0.0',
    language: draft.language ?? previous?.meta.language ?? 'zh-CN',
    rating: draft.rating ?? previous?.meta.rating ?? 'general',
    description: draft.description ?? previous?.meta.description ?? '',
    ...withField('tags', draft.tags === undefined ? undefined : cleanList(draft.tags)),
  };
  const identity: CharacterIdentity = {
    ...previous?.identity,
    name,
    background: draft.background ?? previous?.identity.background ?? '',
    ...withField('occupation', draft.occupation ?? previous?.identity.occupation),
    ...withField('species', draft.species ?? previous?.identity.species),
    ...withField('age', draft.age ?? previous?.identity.age),
    ...withField('gender', draft.gender ?? previous?.identity.gender),
    ...withField('location', draft.location ?? previous?.identity.location),
  };
  const persona: Persona = {
    ...previous?.persona,
    summary,
    traits,
    knowledge_boundary: draft.knowledgeBoundary ?? previous?.persona.knowledge_boundary ?? '',
    ability_boundary: draft.abilityBoundary ?? previous?.persona.ability_boundary ?? '',
    ...withField('default_mood', draft.mood ?? previous?.persona.default_mood),
    ...withField('goals', draft.goals === undefined ? undefined : cleanList(draft.goals)),
    ...withField('fears', draft.fears === undefined ? undefined : cleanList(draft.fears)),
    ...withField('taboos', draft.taboos === undefined ? undefined : cleanList(draft.taboos)),
  };
  const speech: Speech = {
    ...previous?.speech,
    style: draft.speechStyle ?? previous?.speech.style ?? '',
    ...withField('tone', draft.tone ?? previous?.speech.tone),
    ...withField('vocabulary', draft.vocabulary === undefined ? undefined : cleanList(draft.vocabulary)),
    ...withField('forbidden_words', draft.forbiddenWords === undefined ? undefined : cleanList(draft.forbiddenWords)),
    ...withField('example_lines', draft.exampleLines === undefined ? undefined : cleanList(draft.exampleLines)),
    ...withField('narration_style', draft.narrationStyle ?? previous?.speech.narration_style),
  };
  return {
    ...previous,
    card_type: 'character',
    meta,
    identity,
    persona,
    speech,
    ...withField('appearance', appearanceOf(previous?.appearance, draft.appearanceSummary)),
    ...withField('prompts', promptsOf(previous?.prompts, draft)),
    ...withField('brief', draft.brief),
  };
}

// ---------------------------------------------------------------- 旧仓储草稿 → 卡片

/**
 * 旧 `characters.save(draft)` → 待写入的卡片。过渡兼容路径：旧草稿允许只给名字，
 * 因此这里不额外要求卡片必填字段齐全（编辑器走 `cards.save`，会先做 `validateCard`）。
 * description → meta.description + identity.background；personality → summary/traits；
 * systemPrompt → prompts.system_extra；scenario / 开场白 → 丢弃（由兼容草稿承接）。
 */
export function cardFromCharacterDraft(state: MaterializedState, draft: CharacterDraft): CharacterCard {
  const name = (draft.name ?? '').trim();
  if (name === '') throw new DataError('invalid-argument', '角色名不能为空');
  if (name.length > 60) throw new DataError('invalid-argument', '角色名过长（最多 60 字）');
  let existing: CharacterCard | undefined;
  if (draft.id !== undefined) {
    const record = liveCard(state, draft.id);
    if (record !== undefined && record.card.card_type === 'character') {
      existing = record.card;
    } else {
      if (state.cards[draft.id] !== undefined) throw new DataError('invalid-argument', '找不到该角色');
      const legacy = state.characters[draft.id];
      if (legacy === undefined || legacy.deleted !== undefined) throw new DataError('invalid-argument', '找不到该角色');
      // 迁移尚未跑/失败：先把旧记录投影成卡，再把这次草稿合并进去
      existing = cardFromLegacyCharacter(characterView(legacy));
    }
  }
  return applyDraftToCard(existing, {
    id: draft.id,
    name,
    description: draft.description,
    background: draft.description,
    personalitySummary: draft.personality,
    systemExtra: draft.systemPrompt,
  });
}
