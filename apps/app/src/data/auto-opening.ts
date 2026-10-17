/**
 * 智能开场（`opening_mode: 'auto'`）：用模型生成"这一局的第一段开场"。
 *
 * 三条纪律：
 *  1. **纯逻辑**：装配走 `buildChatRequestV2`（同一套块表/预算），模型调用由 `ChatClient` 注入，
 *     因此能在 Node 里用假客户端穷举成功 / 空输出 / 抛错 / 超时；
 *  2. **不假装成功**：任何异常都折成 `{ ok:false, error }` 返回给界面，由界面如实提示并降级为
 *     `opening_mode:'self'`（仍然建会话，从空白开始）；
 *  3. **确定性**：同输入同 prompt（历史固定为空，只用一条触发消息），不引入时间/随机。
 */

import {
  partitionCards,
  type CardDocument,
  type OpeningMode,
  type SessionRuntime,
  type SessionSetup,
  type Tone,
  type WorldPackManifest,
} from '../../../../packages/cards/src/index.ts';
import type { AssembleFn } from '../../../../plugins/writing-pipeline/src/index.ts';
import type { ChatCall, ChatClient } from './chat-client.ts';
import { characterCardOfLegacy } from './card-fallback.ts';
import { describeError } from './error-text.ts';
import { candidatesFor } from './model-routing.ts';
import type { ChatPromptMessage } from './tokens.ts';
import { buildChatRequestV2, type BuildChatRequestV2Options } from './prompt-v2.ts';
import type { CardLibraryEntry, Repository } from './repository.ts';
import { SETTING_KEYS, type Character } from './types.ts';

/** 固定中文指令：放在系统提示最前（排进 custom 块，块表本身不动）。 */
export const OPENING_INSTRUCTION =
  '现在只输出这一局的开场：以角色身份写 2–4 句（不超过 200 字），第二人称叙事，不替用户行动，结尾留一个可回应的钩子；不要解释你在创作，不要输出标题或用引号包裹整段。';

/** 空历史时唯一发给模型的触发消息（开场不是对某句话的回复）。 */
export const OPENING_TRIGGER = '开始这一局。';

export const DEFAULT_OPENING_TIMEOUT_MS = 15_000;

export interface OpeningRequestInput {
  settings: Record<string, string>;
  sessionTitle: string;
  setup: SessionSetup;
  cards: readonly CardDocument[];
  runtime: SessionRuntime;
  assemble?: AssembleFn;
}

/**
 * 开场的装配入参。
 *
 * 刻意复用 `custom` 这条既有通道：把"开场指令 + 设置里的自定义提示"拼成系统提示的最前一段。
 * 这样不新增块、不改块表，预算/理由/trace 仍然由 `buildChatRequestV2` 统一算。
 */
export function buildOpeningPrompt(input: OpeningRequestInput): BuildChatRequestV2Options {
  const custom = (input.settings[SETTING_KEYS.systemPrompt] ?? '').trim();
  const systemPrompt = custom === '' ? OPENING_INSTRUCTION : `${OPENING_INSTRUCTION}\n${custom}`;
  return {
    cite: false,
    settings: { ...input.settings, [SETTING_KEYS.systemPrompt]: systemPrompt },
    sessionTitle: input.sessionTitle,
    setup: input.setup,
    cards: input.cards,
    runtime: input.runtime,
    history: [],
    ...(input.assemble === undefined ? {} : { assemble: input.assemble }),
  };
}

/** 生成结果：失败也走返回值（界面不需要 try/catch 才知道发生了什么）。 */
export type GenerateOpeningResult = { ok: true; text: string } | { ok: false; error: string };

export interface GenerateOpeningInput extends OpeningRequestInput {
  chat: ChatClient;
  /** 超时（默认 15 秒）。测试用小值注入，避免真等 15 秒。 */
  timeoutMs?: number;
}

function timeoutText(ms: number): string {
  return `开场生成超时（${Math.round(ms / 1000)} 秒）`;
}

/**
 * 调模型生成开场；**不抛异常**。
 *
 * `chat.reply` 的 `signal` 是宿主取消通道：超时后 abort，界面立即回到可操作状态，
 * 同时把"超时"作为可读原因返回（不能把超时说成"用户取消"）。
 */
export async function generateOpening(input: GenerateOpeningInput): Promise<GenerateOpeningResult> {
  if (input.chat.available !== true) {
    return { ok: false, error: '当前环境不能调用模型（需要桌面或 Android 宿主）' };
  }
  const request = buildChatRequestV2(buildOpeningPrompt(input));
  // 历史为空：只发一条触发消息；开场的"指令"已经在系统提示里
  const messages: ChatPromptMessage[] = [...request.messages, { role: 'user', content: OPENING_TRIGGER }];
  const timeoutMs = input.timeoutMs ?? DEFAULT_OPENING_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    // 与聊天页一致：按任务取第一个候选配置（空 id = 默认那组设置）；失败由宿主/模型报错，不换人重试
    const candidate = candidatesFor(input.settings, 'chat')[0];
    const call: ChatCall = {
      messages,
      systemPrompt: request.systemPrompt,
      ...(candidate === undefined || candidate.id === '' ? {} : { profileId: candidate.id }),
    };
    const result = await input.chat.reply(call, { signal: controller.signal });
    if (timedOut) return { ok: false, error: timeoutText(timeoutMs) };
    if (result.aborted) return { ok: false, error: '开场生成被中断' };
    const text = result.text.trim();
    return text === '' ? { ok: false, error: '模型返回了空内容' } : { ok: true, text };
  } catch (cause) {
    return { ok: false, error: timedOut ? timeoutText(timeoutMs) : describeError(cause) };
  } finally {
    clearTimeout(timer);
  }
}

/** 会话创建前的运行时预览：把当前场景设成 setup 指定的舞台（与 `deriveRuntime` 的首个场景一致）。 */
export function previewOpeningRuntime(setup: SessionSetup): SessionRuntime {
  return {
    variables: { session: {} },
    items: {},
    scene_state: {},
    ...(setup.scene_id === undefined || setup.scene_id.trim() === '' ? {} : { current_scene_id: setup.scene_id.trim() }),
  };
}

function mountedSetOf(setup: SessionSetup, packCardIds: ReadonlyMap<string, readonly string[]>): Set<string> | undefined {
  const mounts = setup.mounts ?? (setup.world_pack_ids === undefined ? undefined : { pack_ids: setup.world_pack_ids });
  if (mounts === undefined) return undefined;
  const ids = new Set<string>(mounts.card_ids ?? []);
  for (const packId of mounts.pack_ids ?? []) {
    for (const cardId of packCardIds.get(packId) ?? []) ids.add(cardId);
  }
  return ids;
}

/**
 * 会话创建前的卡片筛选：与真正会话用同一套激活规则（库启停 / 资源池 / 按类型），
 * 所以开场看到的角色、场景、典籍与进入聊天后第一轮一致。
 */
export function previewOpeningCards(input: {
  cards: readonly CardDocument[];
  setup: SessionSetup;
  packCardIds?: ReadonlyMap<string, readonly string[]>;
  library?: readonly CardLibraryEntry[];
}): CardDocument[] {
  const enabled = new Map((input.library ?? []).map((entry) => [entry.id, entry.enabled] as const));
  const mounted = mountedSetOf(input.setup, input.packCardIds ?? new Map());
  return partitionCards(input.cards, {
    setup: input.setup,
    runtime: previewOpeningRuntime(input.setup),
    isLibraryEnabled: (cardId) => enabled.get(cardId) ?? true,
    ...(mounted === undefined ? {} : { mounted }),
  }).active;
}

/** 表单里与本局配置有关的字段（纯数据，屏幕只负责收集）。 */
export interface SessionCreateFormState {
  characters: readonly string[];
  packIds: readonly string[];
  cardIds: readonly string[];
  sceneId: string;
  premise: string;
  userRole: string;
  setting: string;
  tone: Tone | '';
}

/** 表单 + 开场选择 → `SessionSetup`（三种开场模式的差异都收在这里，屏幕不再各写一遍）。 */
export function composeSessionSetup(
  form: SessionCreateFormState,
  opening: { mode: OpeningMode; text?: string; speaker?: string },
): SessionSetup {
  const openingText = (opening.text ?? '').trim();
  return {
    characters: [...form.characters],
    ...(form.packIds.length === 0 && form.cardIds.length === 0
      ? {}
      : {
          mounts: {
            ...(form.packIds.length === 0 ? {} : { pack_ids: [...form.packIds] }),
            ...(form.cardIds.length === 0 ? {} : { card_ids: [...form.cardIds] }),
          },
        }),
    ...(form.sceneId === '' ? {} : { scene_id: form.sceneId }),
    premise: form.premise.trim(),
    ...(form.userRole.trim() === '' ? {} : { user_role: form.userRole.trim() }),
    ...(form.setting.trim() === '' ? {} : { setting: form.setting.trim() }),
    ...(form.tone === '' ? {} : { tone: form.tone }),
    opening_mode: opening.mode,
    ...(opening.mode === 'designated'
      ? {
          ...(opening.speaker === undefined ? {} : { opening_speaker: opening.speaker }),
          ...(openingText === '' ? {} : { opening_input: openingText }),
        }
      : {}),
    origin: 'user',
  };
}

/** 智能开场用的卡片集：卡片仓储缺失时退回旧角色记录的兼容投影（与成员列表同一套兜底）。 */
export function openingCardsFor(input: {
  cards: readonly CardDocument[];
  legacyCharacters?: readonly Character[];
  setup: SessionSetup;
  packs?: readonly WorldPackManifest[];
  libraryEnabled?: ReadonlyMap<string, boolean>;
}): CardDocument[] {
  if (input.legacyCharacters !== undefined) return input.legacyCharacters.map(characterCardOfLegacy);
  return previewOpeningCards({
    cards: input.cards,
    setup: input.setup,
    packCardIds: new Map((input.packs ?? []).map((pack) => [pack.id, pack.card_ids] as const)),
    library: [...(input.libraryEnabled ?? new Map<string, boolean>()).entries()].map(([id, enabled]) => ({ id, enabled })),
  });
}

/** 屏幕初始化时要读的三样东西；卡片仓储不存在时返回 undefined（调用方走旧记录兜底）。 */
export interface SessionCreateResources {
  cards: CardDocument[];
  packs: WorldPackManifest[];
  library: CardLibraryEntry[];
}

export async function loadSessionCreateResources(repository: Repository): Promise<SessionCreateResources | undefined> {
  const cardStore = repository.cards;
  if (cardStore === undefined) return undefined;
  const packStore = repository.packs;
  const [cards, packs, library] = await Promise.all([
    cardStore.list(),
    packStore === undefined ? Promise.resolve([]) : packStore.list(),
    cardStore.library().catch(() => []),
  ]);
  return { cards, packs, library };
}
