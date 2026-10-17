/**
 * 「按开局配置建会话」的纯 op 构造（ADR-0011）。
 *
 * 与 `op-repository.ts` 的 `create` 分开：旧入口保持"选一条开场白"的历史语义，
 * 新入口由 `SessionCreateScreen` 传入完整的 `SessionSetup`（多成员 / 资源池 / 处境 / 开场模式）。
 * 这里只做校验与生成 op，不写盘、不依赖 React —— 因此能在 Node 里穷举。
 *
 * 写入顺序固定：`session.create` → `session.setup` →（可选）开场 `message.append`。
 */

import {
  liveStash,
  messageAppend,
  sessionCreate,
  sessionSetup,
  ulid,
  type HlcClock,
  type MaterializedState,
  type Op,
} from '../../../../packages/oplog/src/index.ts';
import type { OpeningMode, SessionSetup } from '../../../../packages/cards/src/index.ts';
import { compatibleCharacter, characterNameOf } from './character-compat.ts';
import { DataError } from './repository.ts';

/** 按完整开局配置创建会话的入参（与 `SessionStore.createWithSetup` 的签名一致）。 */
export interface CreateSessionWithSetupInput {
  characterIds: readonly string[];
  setup: SessionSetup;
  title?: string;
}

/** 与迁移/兼容草稿共用：开场白草稿里第一条与备选之间的分隔符。 */
const OPENING_SEPARATOR = '\n\n---\n\n';

/** 取某角色开场白草稿的首段（多份时按 HLC 取最新；空串视为没有）。 */
function openingFromStash(state: MaterializedState, characterId: string): string | undefined {
  const entries = liveStash(state).filter(
    (record) => record.entry.kind === 'opening' && record.entry.character_id === characterId,
  );
  entries.sort((a, b) => a.updatedHlc.t - b.updatedHlc.t || a.updatedHlc.c - b.updatedHlc.c || a.opId.localeCompare(b.opId));
  const text = entries[entries.length - 1]?.entry.text;
  if (text === undefined) return undefined;
  const first = (text.split(OPENING_SEPARATOR)[0] ?? '').trim();
  return first === '' ? undefined : first;
}

/** 空 mounts（`{}` 或两个空数组）= 不填 = 全库可用（与读取侧的语义一致）。 */
function normalizedMounts(setup: SessionSetup): SessionSetup['mounts'] | undefined {
  const mounts = setup.mounts;
  if (mounts === undefined) return undefined;
  const packIds = [...new Set((mounts.pack_ids ?? []).map((id) => id.trim()).filter((id) => id !== ''))];
  const cardIds = [...new Set((mounts.card_ids ?? []).map((id) => id.trim()).filter((id) => id !== ''))];
  if (packIds.length === 0 && cardIds.length === 0) return undefined;
  return {
    ...(packIds.length === 0 ? {} : { pack_ids: packIds }),
    ...(cardIds.length === 0 ? {} : { card_ids: cardIds }),
  };
}

/** `auto` 尚未实现（模型生成开场）：按 `self` 落地，不假装生成过。 */
function normalizedMode(mode: OpeningMode): OpeningMode {
  return mode === 'auto' ? 'self' : mode;
}

/**
 * 校验 + 生成创建会话所需的 op。
 *
 * 规则：
 *  - 至少一个成员，且每个成员要么有角色卡、要么有旧 `characters` 记录；
 *  - `setup.characters` **以入参 `characterIds` 为准重写**（调用方传错也不影响落库）；
 *  - `designated`：优先 `opening_input`，否则取 `opening_speaker` 的开场白草稿首段；有内容才写消息；
 *  - `self`（以及降级的 `auto`）：不写开场消息。
 */
export function sessionCreateOpsFor(
  state: MaterializedState,
  base: { deviceId: string; clock: HlcClock },
  input: CreateSessionWithSetupInput,
): { sessionId: string; ops: Op[] } {
  const characterIds = [...new Set(input.characterIds.map((id) => id.trim()).filter((id) => id !== ''))];
  if (characterIds.length === 0) throw new DataError('invalid-argument', '会话至少需要一个成员');
  // 所有成员必须存在（卡片优先，旧角色记录兜底），否则一条 op 都不写
  for (const id of characterIds) {
    if (compatibleCharacter(state, id) === undefined) throw new DataError('invalid-argument', `角色 ${id} 不存在`);
  }
  const title = (input.title ?? '').trim();
  if (title.length > 120) throw new DataError('invalid-argument', '会话名过长');

  const mode = normalizedMode(input.setup.opening_mode);
  const speaker = input.setup.opening_speaker;
  if (mode === 'designated' && (speaker === undefined || !characterIds.includes(speaker))) {
    throw new DataError('invalid-argument', '指定开场需要一个成员作为开口角色');
  }
  const explicitOpening = (input.setup.opening_input ?? '').trim();
  const opening =
    mode === 'designated'
      ? explicitOpening !== ''
        ? explicitOpening
        : speaker === undefined
          ? undefined
          : openingFromStash(state, speaker)
      : undefined;

  const mounts = normalizedMounts(input.setup);
  const sceneId = (input.setup.scene_id ?? '').trim();
  const {
    mounts: _mounts,
    scene_id: _sceneId,
    opening_mode: _mode,
    opening_speaker: _speaker,
    opening_input: _openingInput,
    ...rest
  } = input.setup;
  const setup: SessionSetup = {
    ...rest,
    characters: characterIds,
    opening_mode: mode,
    ...(mounts === undefined ? {} : { mounts }),
    ...(sceneId === '' ? {} : { scene_id: sceneId }),
    ...(mode === 'designated' && speaker !== undefined ? { opening_speaker: speaker } : {}),
    ...(mode === 'designated' && explicitOpening !== '' ? { opening_input: explicitOpening } : {}),
  };

  const firstId = characterIds[0] ?? '';
  const sessionId = ulid();
  const ops: Op[] = [
    sessionCreate(base, {
      sessionId,
      title: title === '' ? characterNameOf(state, firstId) : title,
      characterId: firstId,
    }),
    sessionSetup(base, { session_id: sessionId, setup }),
  ];
  if (opening !== undefined) {
    ops.push(messageAppend(base, { sessionId, messageId: ulid(), author: 'character', content: opening }));
  }
  return { sessionId, ops };
}
