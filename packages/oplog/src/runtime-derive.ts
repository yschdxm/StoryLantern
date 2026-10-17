/**
 * 运行时状态的**派生**：从"补丁序列"重放出当前值。
 *
 * 为什么存补丁而不是存当前值：
 *  - 两台设备离线时都改了 `affection`（+5 / +10）。若按 LWW 覆盖，总有一边的增量被丢掉；
 *  - 补丁是"发生过的事"，按 HLC 全序重放的结果与到达顺序无关（收敛），也与重放时刻无关（确定性）；
 *  - 校验（`max_delta_per_turn`、min/max）在**写 op 之前**做（见 `clampStateDelta`）：
 *    若在重放时做，结果会依赖重放起点的当前值，设备之间就会算出不同的数。
 */

import { compareOpOrder } from './hlc.ts';
import type { ItemInstance, SessionRuntime, StateValue } from '../../cards/src/index.ts';
import type { MaterializedState, RuntimePatchRecord } from './state-types.ts';

/** 变量作用域的键：`character:<id>` 或 `session`。 */
export function scopeKey(scope: { kind: 'character'; id: string } | { kind: 'session' }): string {
  return scope.kind === 'character' ? `character:${scope.id}` : 'session';
}

/** 把一套变量定义渲染成默认值（`state.schema` → `{ name: default }`）。 */
export function defaultsFrom(state: MaterializedState, characterId: string): Record<string, StateValue> {
  const record = state.cards[characterId];
  const out: Record<string, StateValue> = {};
  if (record === undefined || record.card.card_type !== 'character' || record.card.state === undefined) return out;
  for (const [name, def] of Object.entries(record.card.state.schema)) out[name] = def.default;
  return out;
}

/** 某会话的补丁（按 op 全序排好；追加时乱序到达也在这里归位）。 */
export function patchesOf(state: MaterializedState, sessionId: string): RuntimePatchRecord[] {
  return [...(state.runtimePatches[sessionId] ?? [])].sort((a, b) =>
    compareOpOrder({ hlc: a.hlc, opId: a.opId }, { hlc: b.hlc, opId: b.opId }),
  );
}

/**
 * 派生某个会话的运行时状态。纯函数：同样的 state 必得同样的结果。
 *
 * 起始值 = 卡片 `state.schema` 默认值 → 会被 `setup.init_state` 覆盖 → 再按序应用补丁。
 */
export function deriveRuntime(state: MaterializedState, sessionId: string): SessionRuntime {
  const setup = state.setups[sessionId]?.setup;
  const variables: Record<string, Record<string, StateValue>> = { session: {} };
  const items: Record<string, ItemInstance> = {};
  const sceneState: Record<string, Record<string, StateValue>> = {};
  let currentSceneId: string | undefined = setup?.scene_id;

  for (const characterId of setup?.characters ?? []) {
    const values = defaultsFrom(state, characterId);
    const overrides = setup?.init_state?.[characterId];
    if (overrides !== undefined) for (const [name, value] of Object.entries(overrides)) values[name] = value;
    variables[`character:${characterId}`] = values;
  }

  for (const patch of patchesOf(state, sessionId)) {
    for (const delta of patch.deltas) {
      if (delta.kind === 'state') {
        const key = scopeKey(delta.scope);
        const bucket = variables[key] ?? (variables[key] = {});
        applyStateDelta(bucket, delta.name, delta.op, delta.value);
      } else if (delta.kind === 'item') {
        if (delta.action === 'grant') items[delta.instance.instance_id] = delta.instance;
        else if (delta.action === 'consume') delete items[delta.instance_id];
        else {
          const existing = items[delta.instance_id];
          if (existing !== undefined) {
            items[delta.instance_id] = {
              ...existing,
              ...(delta.holder === undefined ? {} : { holder: delta.holder }),
              ...(delta.condition === undefined ? {} : { condition: { ...existing.condition, ...delta.condition } }),
              ...(delta.changes === undefined
                ? {}
                : { changes: [...(existing.changes ?? []), ...delta.changes] }),
              ...(delta.notes === undefined ? {} : { notes: delta.notes }),
            };
          }
        }
      } else {
        // kind === 'scene'
        currentSceneId = delta.scene_id;
        const bucket = sceneState[delta.scene_id] ?? (sceneState[delta.scene_id] = {});
        for (const [key, value] of Object.entries(delta.state ?? {})) {
          if (value === null) delete bucket[key];
          else bucket[key] = value;
        }
      }
    }
  }

  return {
    variables,
    items,
    scene_state: sceneState,
    ...(currentSceneId === undefined ? {} : { current_scene_id: currentSceneId }),
  };
}

function applyStateDelta(
  bucket: Record<string, StateValue>,
  name: string,
  op: 'add' | 'replace' | 'remove',
  value: StateValue | undefined,
): void {
  if (op === 'remove') {
    delete bucket[name];
    return;
  }
  if (op === 'replace') {
    bucket[name] = value ?? null;
    return;
  }
  const current = bucket[name];
  // 数值加法；非数值的 add 视为无效（校验器会拦下生产者，这里只做防御，不猜意图）
  if (typeof current === 'number' && typeof value === 'number') bucket[name] = current + value;
}

export interface ClampResult {
  value: number;
  /** 被引擎截断过（界面要如实提示"数值被限制"）。 */
  clamped: boolean;
}

/**
 * 生产者侧的数值校验：把一次 `add` 夹在 `[min, max]` 与 `max_delta_per_turn` 之内。
 *
 * 返回最终要写进补丁的**增量值**（不是最终值）。例如当前 95、上限 100、想 +40：
 * 返回 `{value: 5, clamped: true}`。写 op 前调用，重放时就不再改变数值。
 */
export function clampStateDelta(input: {
  current: number;
  delta: number;
  min?: number;
  max?: number;
  maxDeltaPerTurn?: number;
}): ClampResult {
  let delta = input.delta;
  let clamped = false;
  if (input.maxDeltaPerTurn !== undefined && Math.abs(delta) > input.maxDeltaPerTurn) {
    delta = Math.sign(delta) * input.maxDeltaPerTurn;
    clamped = true;
  }
  const target = input.current + delta;
  const min = input.min ?? Number.NEGATIVE_INFINITY;
  const max = input.max ?? Number.POSITIVE_INFINITY;
  const bounded = Math.min(max, Math.max(min, target));
  if (bounded !== target) clamped = true;
  return { value: bounded - input.current, clamped };
}
