/**
 * 新版上下文块（与旧 `prompt-blocks.ts` 并存，不引用旧实现的运行时函数）。
 *
 * 块的 id / placement / priority 就是"模型看到什么"的可解释性合同：
 * 系统侧 custom(100) → setup(99) → rules(98) → character(95) → state(90) → scene(88) → items(86) → examples(84)；
 * 检索侧 before-history：memory(82) → summary(80) → lore(78)。历史消息不进块（要保留 role 结构）。
 * 记忆/摘要/典籍的检索在 `prompt-v2.ts` 装配前算好写进 `data.retrieval`，这里只负责排版。
 */

import type { BlockContext, BlockDefinition, BlockPlacement, BlockRegistry } from '../../../../plugins/context-blocks/src/index.ts';
import type {
  Atmosphere,
  CharacterCard,
  ItemCard,
  ItemInstance,
  LoreCard,
  OccupantPresence,
  SceneCard,
  SessionRuntime,
  SessionSetup,
  StateValue,
  StateVarDef,
  Tone,
} from '../../../../packages/cards/src/index.ts';
import type { ScoredEntry } from '../../../../packages/lore/src/index.ts';
import type { RetrievedMemory } from './memory-retrieval.ts';
import type { PromptSummary } from './prompt-blocks.ts';
import type { Memory, MessageRole } from './types.ts';

/** 装配时用到的卡片索引（按 id 排序建，保证与输入数组顺序无关）。 */
export interface PromptWorldV2 {
  /** 成员角色（顺序由 `setup.characters` 决定；空 setup 时按 id）。 */
  readonly members: readonly CharacterCard[];
  readonly characterById: ReadonlyMap<string, CharacterCard>;
  readonly sceneById: ReadonlyMap<string, SceneCard>;
  readonly itemById: ReadonlyMap<string, ItemCard>;
  readonly loreCards: readonly LoreCard[];
}

/** 本次实际注入的检索结果（装配前写入，供 trace 读取）。 */
export interface PromptOutcomesV2 {
  matchedLore: ScoredEntry[];
  loreDropped: number;
  matchedMemories: RetrievedMemory[];
  matchedSummaries: PromptSummary[];
  rulesOmitted: number;
}

/** 检索块渲染用的文本：由 prompt-v2 预计算；未设表示本块这次不出。 */
export interface PromptRetrievalTextV2 {
  memory?: string;
  summary?: string;
  lore?: string;
}

/** 块的类型化数据视图（唯一收口在 `dataOf`）。 */
export interface PromptBlockDataV2 {
  custom: string;
  setup: SessionSetup;
  world: PromptWorldV2;
  runtime: SessionRuntime;
  history: ReadonlyArray<{ role: MessageRole; content: string }>;
  memories: readonly Memory[];
  summaries: readonly PromptSummary[];
  preselectedSummaries?: readonly PromptSummary[];
  loreBudgetChars?: number;
  /** 概率判定的确定性种子：最后一条历史消息的 id（缺 id 时见 prompt-v2 的替代）。 */
  lastMessageKey: string;
  retrieval: PromptRetrievalTextV2;
  outcomes: PromptOutcomesV2;
}

const TONE_LABELS: Readonly<Record<Tone, string>> = { light: '轻松', serious: '严肃', dark: '黑暗', mystery: '悬疑' };
const PRESENCE_LABELS: Readonly<Record<OccupantPresence, string>> = {
  resident: '常驻',
  frequent: '常来',
  occasional: '偶尔',
  rare: '罕见',
};
const ATMOSPHERE_FIELDS: ReadonlyArray<readonly [Exclude<keyof Atmosphere, 'other'>, string]> = [
  ['light', '光'],
  ['sound', '声'],
  ['smell', '气味'],
  ['temperature', '温度'],
  ['crowd', '人群'],
  ['mood', '气氛'],
];
const PLACEMENT_ORDER: readonly BlockPlacement[] = ['system', 'before-history', 'at-depth', 'after-history'];

function dataOf(context: BlockContext): PromptBlockDataV2 {
  return (context.data ?? {}) as unknown as PromptBlockDataV2;
}
function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}
function isStringArray(value: StateValue): value is readonly string[] {
  return Array.isArray(value);
}
function formatValue(value: StateValue): string {
  if (value === null) return '无';
  return isStringArray(value) ? value.join('、') : String(value);
}
function labeled(label: string, value: string | undefined): string {
  const text = trimmed(value);
  return text === '' ? '' : `${label}：${text}`;
}
function joinParts(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join('；');
}
function pushText(lines: string[], label: string, value: string | undefined): void {
  const text = trimmed(value);
  if (text !== '') lines.push(`【${label}】${text}`);
}
function pushList(lines: string[], label: string, values: readonly string[] | undefined): void {
  const text = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .join('、');
  if (text !== '') lines.push(`【${label}】${text}`);
}

/** 角色卡 → 角色块正文。空字段不留标题。 */
export function renderCharacterSection(character: CharacterCard): string {
  const name = trimmed(character.identity.name) || trimmed(character.meta.name);
  const lines: string[] = [`你要扮演「${name}」。`];
  const identity = joinParts([
    labeled('职业', character.identity.occupation),
    labeled('种族', character.identity.species),
    labeled('年龄', character.identity.age),
    labeled('性别', character.identity.gender),
    labeled('背景', character.identity.background),
  ]);
  if (identity !== '') lines.push(`【身份】${identity}`);
  const appearance = trimmed(character.appearance?.['summary']);
  if (appearance !== '') lines.push(`【外观】${appearance}`);
  const persona = character.persona;
  const personality = joinParts([trimmed(persona.summary), persona.traits.map((trait) => trait.trim()).filter((trait) => trait !== '').join('、')]);
  if (personality !== '') lines.push(`【性格】${personality}`);
  pushList(lines, '目标', persona.goals);
  pushList(lines, '恐惧', persona.fears);
  pushList(lines, '禁忌', persona.taboos);
  pushText(lines, '认知边界', persona.knowledge_boundary);
  pushText(lines, '能力边界', persona.ability_boundary);
  const speech = character.speech;
  const tone = joinParts([
    trimmed(speech.style),
    trimmed(speech.tone),
    (speech.vocabulary ?? []).map((word) => word.trim()).filter((word) => word !== '').join('、'),
  ]);
  if (tone !== '') lines.push(`【语气】${tone}`);
  pushList(lines, '禁词', speech.forbidden_words);
  const exampleLines = (speech.example_lines ?? []).map((line) => line.trim()).filter((line) => line !== '');
  if (exampleLines.length > 0) lines.push(`【台词示例】\n${exampleLines.map((line) => `- ${line}`).join('\n')}`);
  pushText(lines, '旁白风格', speech.narration_style);
  const prompts = character.prompts;
  pushText(lines, '角色补充', prompts?.system_extra);
  const roleplayRules = (prompts?.roleplay_rules ?? []).map((rule) => rule.trim()).filter((rule) => rule !== '');
  if (roleplayRules.length > 0) lines.push(`【扮演规则】\n${roleplayRules.map((rule) => `- ${rule}`).join('\n')}`);
  pushText(lines, '风格', prompts?.style_guide);
  return lines.join('\n');
}

/** 所有成员角色的角色块（管线里合并成一块；兜底路径逐角色拆块）。 */
export function renderCharacterSections(data: PromptBlockDataV2): string | undefined {
  if (data.world.members.length === 0) return undefined;
  return data.world.members.map((character) => renderCharacterSection(character)).join('\n');
}

/** 规则块：只处理 before_prompt 且启用的 constraint / inject_prompt；带条件表达式的跳过并计数。 */
export function renderRulesSection(data: PromptBlockDataV2): string | undefined {
  const rules: Array<{ priority: number; owner: string; id: string; text: string }> = [];
  let omitted = 0;
  for (const character of data.world.members) {
    for (const rule of character.rules ?? []) {
      if (!rule.enabled || rule.when.event !== 'before_prompt') continue;
      if ((rule.when.conditions ?? []).length > 0) {
        // 表达式求值器还没有：宁可少数，也不假装条件规则已生效
        omitted += 1;
        continue;
      }
      const texts = rule.actions
        .filter((action) => action.type === 'constraint' || action.type === 'inject_prompt')
        .map((action) => trimmed(action.text))
        .filter((text) => text !== '');
      if (texts.length === 0) continue;
      rules.push({ priority: rule.priority, owner: character.meta.id, id: rule.id, text: texts.join('\n') });
    }
  }
  data.outcomes.rulesOmitted = omitted;
  rules.sort((a, b) => b.priority - a.priority || a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id));
  return rules.length === 0 ? undefined : rules.map((rule) => rule.text).join('\n');
}

/** 开局配置块：只输出非空项；tone 走中文映射。 */
export function renderSetupSection(data: PromptBlockDataV2): string | undefined {
  const setup = data.setup;
  const lines: string[] = [];
  pushText(lines, '本局处境', setup.premise);
  pushText(lines, '你的身份', setup.user_role);
  pushText(lines, '世界基调', setup.setting);
  pushText(lines, '基调', setup.tone === undefined ? '' : TONE_LABELS[setup.tone]);
  return lines.length === 0 ? undefined : lines.join('\n');
}

function sortedKeys(record: Readonly<Record<string, StateValue>>): string[] {
  return Object.keys(record).sort((a, b) => a.localeCompare(b));
}
function stateLine(fallback: string, name: string, value: StateValue, definition: StateVarDef | undefined): string {
  const template = trimmed(definition?.prompt_render);
  return template === ''
    ? `${fallback}: ${formatValue(value)}`
    : template.replaceAll('{{name}}', name).replaceAll('{{value}}', formatValue(value));
}

/** 状态块：成员角色的可见变量 + 会话级变量；没有变量就整块不出。 */
export function renderStateSection(data: PromptBlockDataV2): string | undefined {
  const lines: string[] = [];
  for (const character of data.world.members) {
    const scope = data.runtime.variables[`character:${character.meta.id}`];
    if (scope === undefined) continue;
    const name = trimmed(character.identity.name) || trimmed(character.meta.name);
    for (const variable of sortedKeys(scope)) {
      const definition = character.state?.schema[variable];
      if (definition?.visible_to_user === false) continue;
      const value = scope[variable];
      if (value === undefined) continue;
      lines.push(`- ${stateLine(`${name}.${variable}`, variable, value, definition)}`);
    }
  }
  const session = data.runtime.variables['session'];
  if (session !== undefined) {
    for (const variable of sortedKeys(session)) {
      const value = session[variable];
      if (value !== undefined) lines.push(`- ${stateLine(`本局.${variable}`, variable, value, undefined)}`);
    }
  }
  return lines.length === 0 ? undefined : `【当前状态】\n${lines.join('\n')}`;
}

function resolveName<T extends { meta: { name: string } }>(map: ReadonlyMap<string, T>, id: string): string {
  return trimmed(map.get(id)?.meta.name) || id;
}
function atmosphereText(atmosphere: Atmosphere | undefined): string {
  if (atmosphere === undefined) return '';
  return ATMOSPHERE_FIELDS.map(([key, label]) => labeled(label, atmosphere[key]))
    .filter((part) => part !== '')
    .join('；');
}

/** 场景块：当前场景（`runtime.current_scene_id`）；引用解析不到时降级为 ID，不抛异常。 */
export function renderSceneSection(data: PromptBlockDataV2): string | undefined {
  const sceneId = data.runtime.current_scene_id;
  if (sceneId === undefined) return undefined;
  const scene = data.world.sceneById.get(sceneId);
  if (scene === undefined) return undefined;
  const lines: string[] = [`【当前场景】${trimmed(scene.meta.name)}`];
  const summary = trimmed(scene.appearance?.['summary']) || trimmed(scene.brief);
  if (summary !== '') lines.push(summary);
  const atmosphere = atmosphereText(scene.atmosphere);
  if (atmosphere !== '') lines.push(atmosphere);
  const connections = [...new Set((scene.connections ?? []).map((item) => resolveName(data.world.sceneById, item.target)))];
  if (connections.length > 0) lines.push(`【可去】${connections.join('、')}`);
  const occupants = [
    ...new Set(
      (scene.occupants ?? []).map(
        (item) => `${resolveName(data.world.characterById, item.target)}（${PRESENCE_LABELS[item.presence]}）`,
      ),
    ),
  ];
  if (occupants.length > 0) lines.push(`【在场】${occupants.join('、')}`);
  return lines.join('\n');
}

function conditionText(condition: Readonly<Record<string, StateValue>> | undefined): string {
  if (condition === undefined) return '';
  return sortedKeys(condition)
    .map((key) => {
      const value = condition[key];
      if (value === undefined || value === null || value === '') return '';
      return isStringArray(value) && value.length === 0 ? '' : `${key}：${formatValue(value)}`;
    })
    .filter((part) => part !== '')
    .join('，');
}

/** 物品块：只输出成员角色持有的实例；condition 里没有值的项不输出（item 无 schema，见契约缺口）。 */
export function renderItemsSection(data: PromptBlockDataV2): string | undefined {
  const members = new Set(data.world.members.map((character) => character.meta.id));
  const held: ItemInstance[] = [];
  for (const key of Object.keys(data.runtime.items).sort((a, b) => a.localeCompare(b))) {
    const instance = data.runtime.items[key];
    if (instance !== undefined && members.has(instance.holder)) held.push(instance);
  }
  if (held.length === 0) return undefined;
  const lines = held.map((instance) => {
    const item = data.world.itemById.get(instance.item_id);
    const name = trimmed(item?.meta.name) || instance.item_id;
    const condition = conditionText(instance.condition);
    return condition === '' ? `- ${name}` : `- ${name}（${condition}）`;
  });
  return `【持有物品】\n${lines.join('\n')}`;
}

/** 示例对话块：第一轮优先冷启动那组，其它情况取前 2 组；role 原样输出。 */
export function renderExamplesSection(data: PromptBlockDataV2): string | undefined {
  const pool = data.world.members.flatMap((character) => character.examples ?? []);
  if (pool.length === 0) return undefined;
  const coldStart = data.history.length === 0 ? pool.find((example) => (example.tags ?? []).includes('cold_start')) : undefined;
  const selected = coldStart === undefined ? pool.slice(0, 2) : [coldStart];
  const sections = selected
    .map((example) => example.messages.map((message) => `${message.role}: ${message.content.trim()}`).join('\n'))
    .filter((text) => text !== '');
  return sections.length === 0 ? undefined : `【对话示例】\n${sections.join('\n\n')}`;
}

/** 设置里的自定义系统提示（空则整块不出）。 */
export function renderCustomSection(data: PromptBlockDataV2): string | undefined {
  const custom = trimmed(data.custom);
  return custom === '' ? undefined : custom;
}

function defineBlock(
  id: string,
  placement: BlockPlacement,
  priority: number,
  render: (context: BlockContext) => string | undefined,
): BlockDefinition {
  return { id, placement, priority, render };
}

/**
 * 注册静态块（启动/组合时调用一次）。
 *
 * 注意：注册表是全局的、成员角色要到装配时才知道，所以管线路径把所有成员合并成一块
 * `app.character`（priority 95）；兜底路径 `renderAllSections` 才逐角色拆成 `app.character.<id>`。
 * 这是当前 `AssembleFn` 签名拿不到注册表导致的契约缺口（已在交付说明里写清）。
 */
export function registerPromptBlocksV2(blocks: BlockRegistry): () => void {
  const definitions: BlockDefinition[] = [
    defineBlock('app.system.custom', 'system', 100, (context) => renderCustomSection(dataOf(context))),
    defineBlock('app.setup', 'system', 99, (context) => renderSetupSection(dataOf(context))),
    defineBlock('app.rules', 'system', 98, (context) => renderRulesSection(dataOf(context))),
    defineBlock('app.character', 'system', 95, (context) => renderCharacterSections(dataOf(context))),
    defineBlock('app.state', 'system', 90, (context) => renderStateSection(dataOf(context))),
    defineBlock('app.scene', 'system', 88, (context) => renderSceneSection(dataOf(context))),
    defineBlock('app.items', 'system', 86, (context) => renderItemsSection(dataOf(context))),
    defineBlock('app.examples', 'system', 84, (context) => renderExamplesSection(dataOf(context))),
    defineBlock('app.memory.matched', 'before-history', 82, (context) => dataOf(context).retrieval.memory),
    defineBlock('app.summary.matched', 'before-history', 80, (context) => dataOf(context).retrieval.summary),
    defineBlock('app.lore.matched', 'before-history', 78, (context) => dataOf(context).retrieval.lore),
  ];
  const offs = definitions.map((definition) => blocks.register(definition.id, definition));
  return () => {
    for (const off of offs.reverse()) off();
  };
}

export interface PromptSectionV2 {
  id: string;
  text: string;
}

/**
 * 兜底路径的固定顺序拼接（无预算、不裁剪）——与旧实现同构。
 * 与 `assembleBlocks` 用同一套排序规则（placement → priority 降序 → id），两条路径块顺序一致。
 */
export function renderAllSections(data: PromptBlockDataV2): PromptSectionV2[] {
  const entries: Array<{ id: string; placement: BlockPlacement; priority: number; text: () => string | undefined }> = [
    { id: 'app.system.custom', placement: 'system', priority: 100, text: () => renderCustomSection(data) },
    { id: 'app.setup', placement: 'system', priority: 99, text: () => renderSetupSection(data) },
    { id: 'app.rules', placement: 'system', priority: 98, text: () => renderRulesSection(data) },
    ...data.world.members.map((character) => ({
      id: `app.character.${character.meta.id}`,
      placement: 'system' as BlockPlacement,
      priority: 95,
      text: () => renderCharacterSection(character),
    })),
    { id: 'app.state', placement: 'system', priority: 90, text: () => renderStateSection(data) },
    { id: 'app.scene', placement: 'system', priority: 88, text: () => renderSceneSection(data) },
    { id: 'app.items', placement: 'system', priority: 86, text: () => renderItemsSection(data) },
    { id: 'app.examples', placement: 'system', priority: 84, text: () => renderExamplesSection(data) },
    { id: 'app.memory.matched', placement: 'before-history', priority: 82, text: () => data.retrieval.memory },
    { id: 'app.summary.matched', placement: 'before-history', priority: 80, text: () => data.retrieval.summary },
    { id: 'app.lore.matched', placement: 'before-history', priority: 78, text: () => data.retrieval.lore },
  ];
  entries.sort(
    (a, b) =>
      PLACEMENT_ORDER.indexOf(a.placement) - PLACEMENT_ORDER.indexOf(b.placement) ||
      b.priority - a.priority ||
      a.id.localeCompare(b.id),
  );
  const sections: PromptSectionV2[] = [];
  for (const entry of entries) {
    const text = entry.text();
    if (text !== undefined && text !== '') sections.push({ id: entry.id, text });
  }
  return sections;
}
