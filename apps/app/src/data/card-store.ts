import {
  cardDelete,
  cardLibrary,
  cardUpsert,
  clampStateDelta,
  deriveRuntime,
  isCardLibraryEnabled,
  liveCard,
  liveStash,
  listCards,
  listPacks,
  packDelete,
  packUpsert,
  runtimePatch,
  scopeKey,
  sessionSetup,
  setupOf,
  stashDelete,
  stashUpsert,
  type MaterializedState,
  type Materializer,
  type Op,
} from '../../../../packages/oplog/src/index.ts';
import type { HlcClock } from '../../../../packages/oplog/src/index.ts';
import type {
  CardDocument,
  CompatStashEntry,
  RuntimeDelta,
  SessionRuntime,
  SessionSetup,
  StateUpdatePolicy,
  StateValue,
  StateVarDef,
  WorldPackManifest,
} from '../../../../packages/cards/src/index.ts';
import { validateCard } from '../../../../packages/cards/src/validate.ts';
import {
  DataError,
  type CardStore,
  type PackStore,
  type RuntimeStore,
  type SetupStore,
  type StashStore,
} from './repository.ts';

/**
 * 卡片模型的五个 op 仓储（ADR-0011）：卡片 / 开局 / 运行时 / 世界包 / 兼容草稿。
 *
 * 与 `op-message-store.ts` 同一套规矩：
 *  - **写 = 生成 op → `appendAndApply`**（先落盘，再改内存）；
 *  - **读一律派生**：`materializer.state` + oplog 的自由函数（`listCards`/`liveCard`/
 *    `deriveRuntime`/`setupOf`/`listPacks`/`liveStash`），不另存一份可读副本；
 *  - 每个方法都过 `withReady`：迁移与日志载入完成之前不读到半成品。
 *
 * 为什么运行时写入要先做生产者侧校验（`clampStateDelta`）：
 * 重放发生在每台设备上，若在重放时夹取，结果会依赖各自的起始值，设备之间就会算出不同的数。
 * 因此把**最终增量**写进 op，重放只做加法。
 */

export interface CardStoreDeps {
  withReady<T>(action: () => Promise<T>): Promise<T>;
  materializer(): Materializer;
  appendAndApply(ops: Op[]): Promise<void>;
  base(): { deviceId: string; clock: HlcClock };
}

// ---------------------------------------------------------------- 生产者侧校验

type StateDelta = Extract<RuntimeDelta, { kind: 'state' }>;

interface VariableContext {
  current: StateValue | undefined;
  definition?: StateVarDef;
  maxDeltaPerTurn?: number;
}

/** 取变量定义（来自角色卡的 `state.schema`）与当前派生值。 */
function variableContext(
  state: MaterializedState,
  variables: Readonly<Record<string, Readonly<Record<string, StateValue>>>>,
  delta: StateDelta,
): VariableContext {
  const current = variables[scopeKey(delta.scope)]?.[delta.name];
  if (delta.scope.kind !== 'character') return { current };
  const card = liveCard(state, delta.scope.id)?.card;
  if (card === undefined || card.card_type !== 'character' || card.state === undefined) return { current };
  const policy: StateUpdatePolicy = card.state.update_policy;
  return {
    current,
    ...(card.state.schema[delta.name] === undefined ? {} : { definition: card.state.schema[delta.name] }),
    ...(policy.max_delta_per_turn === undefined ? {} : { maxDeltaPerTurn: policy.max_delta_per_turn }),
  };
}

function matchesStateType(definition: StateVarDef, value: StateValue | undefined): boolean {
  if (definition.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (definition.type === 'string') return typeof value === 'string';
  if (definition.type === 'boolean') return typeof value === 'boolean';
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function sameStateValue(a: StateValue, b: StateValue | undefined): boolean {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => item === b[index]);
  return a === b;
}

/** `replace` 必须符合变量定义：类型 / min / max / enum。 */
function assertReplaceAllowed(name: string, value: StateValue | undefined, definition: StateVarDef | undefined): void {
  if (definition === undefined) return;
  if (!matchesStateType(definition, value)) {
    throw new DataError('invalid-argument', `状态变量 ${name} 的取值不符合类型 ${definition.type}`);
  }
  if (typeof value === 'number') {
    if (definition.min !== undefined && value < definition.min) {
      throw new DataError('invalid-argument', `状态变量 ${name} 不能小于 ${definition.min}`);
    }
    if (definition.max !== undefined && value > definition.max) {
      throw new DataError('invalid-argument', `状态变量 ${name} 不能大于 ${definition.max}`);
    }
  }
  if (definition.enum !== undefined && !definition.enum.some((item) => sameStateValue(item, value))) {
    throw new DataError('invalid-argument', `状态变量 ${name} 的取值不在允许范围内`);
  }
}

/**
 * 把一次 patch 里的 state 增量校验收敛成**可以直接写进 op 的增量**。
 *
 * `add`：当前值与增量都必须是数字；按变量定义与 `max_delta_per_turn` 夹取后，
 * 把**夹取后的增量**写进 op（不抛错，界面可如实提示"数值被限制"）。
 * 同一批里多条增量按顺序生效（后一条的夹取基于前一条的结果），因此先复制一份工作副本。
 */
function normalizeStateDeltas(
  state: MaterializedState,
  runtime: SessionRuntime,
  deltas: readonly RuntimeDelta[],
): RuntimeDelta[] {
  const variables: Record<string, Record<string, StateValue>> = {};
  for (const [key, bucket] of Object.entries(runtime.variables)) variables[key] = { ...bucket };

  return deltas.map((delta): RuntimeDelta => {
    if (delta.kind !== 'state') return delta;
    const key = scopeKey(delta.scope);
    const bucket = variables[key] ?? (variables[key] = {});
    const context = variableContext(state, variables, delta);
    if (delta.op === 'remove') {
      delete bucket[delta.name];
      return delta;
    }
    if (delta.op === 'replace') {
      assertReplaceAllowed(delta.name, delta.value, context.definition);
      bucket[delta.name] = delta.value ?? null;
      return delta;
    }
    if (typeof context.current !== 'number' || typeof delta.value !== 'number') {
      throw new DataError('invalid-argument', `状态变量 ${delta.name} 不是数字，不能用 add`);
    }
    const clamped = clampStateDelta({
      current: context.current,
      delta: delta.value,
      ...(context.definition?.min === undefined ? {} : { min: context.definition.min }),
      ...(context.definition?.max === undefined ? {} : { max: context.definition.max }),
      ...(context.maxDeltaPerTurn === undefined ? {} : { maxDeltaPerTurn: context.maxDeltaPerTurn }),
    });
    bucket[delta.name] = context.current + clamped.value;
    return { ...delta, value: clamped.value };
  });
}

// ---------------------------------------------------------------- 卡片

export function createCardStore(deps: CardStoreDeps): CardStore {
  return {
    list: (type) => deps.withReady(async () => listCards(deps.materializer().state, type).map((record) => record.card)),

    get: (id) => deps.withReady(async () => liveCard(deps.materializer().state, id)?.card),

    save: (card: CardDocument) =>
      deps.withReady(async () => {
        // 调用方负责先过 validateCard；这里兜底：有 error 就不写日志（warning 是已知过渡态，不拦）
        const validation = validateCard(card);
        if (!validation.ok) {
          const first = validation.issues.find((issue) => issue.severity === 'error');
          throw new DataError('invalid-argument', first?.message ?? '卡片校验失败');
        }
        await deps.appendAndApply([cardUpsert(deps.base(), { card })]);
        const record = liveCard(deps.materializer().state, card.meta.id);
        if (record === undefined) throw new DataError('store-error', '写入后读不到该卡片');
        return record.card;
      }),

    remove: (id) =>
      deps.withReady(async () => {
        // 不存在或已删都返回 false（墓碑存在，不做二次写入）
        if (liveCard(deps.materializer().state, id) === undefined) return false;
        await deps.appendAndApply([cardDelete(deps.base(), { card_id: id })]);
        return true;
      }),

    library: () =>
      deps.withReady(async () => {
        const state = deps.materializer().state;
        return listCards(state).map((record) => ({ id: record.id, enabled: isCardLibraryEnabled(state, record.id) }));
      }),

    setEnabled: (id, enabled) =>
      deps.withReady(async () => {
        if (liveCard(deps.materializer().state, id) === undefined) {
          throw new DataError('invalid-argument', '卡片不存在');
        }
        await deps.appendAndApply([cardLibrary(deps.base(), { card_id: id, enabled })]);
      }),
  };
}

// ---------------------------------------------------------------- 开局配置

export function createSetupStore(deps: CardStoreDeps): SetupStore {
  return {
    get: (sessionId) => deps.withReady(async () => setupOf(deps.materializer().state, sessionId)?.setup),

    save: (sessionId, setup: SessionSetup) =>
      deps.withReady(async () => {
        if (setup.characters.length === 0) throw new DataError('invalid-argument', '开局配置至少需要一个角色');
        const session = deps.materializer().state.sessions[sessionId];
        if (session === undefined || session.deleted !== undefined) throw new DataError('invalid-argument', '会话不存在');
        await deps.appendAndApply([sessionSetup(deps.base(), { session_id: sessionId, setup })]);
        return setupOf(deps.materializer().state, sessionId)?.setup ?? setup;
      }),
  };
}

// ---------------------------------------------------------------- 运行时

export function createRuntimeStore(deps: CardStoreDeps): RuntimeStore {
  const requireSession = (sessionId: string): void => {
    const session = deps.materializer().state.sessions[sessionId];
    if (session === undefined || session.deleted !== undefined) throw new DataError('invalid-argument', '会话不存在');
  };

  return {
    get: (sessionId) => deps.withReady(async () => deriveRuntime(deps.materializer().state, sessionId)),

    patch: (input) =>
      deps.withReady(async () => {
        requireSession(input.sessionId);
        const runtime = deriveRuntime(deps.materializer().state, input.sessionId);
        // 空补丁不写空 op：读接口不该因为"什么都没发生"而留下噪音
        if (input.deltas.length === 0) return runtime;
        const deltas = normalizeStateDeltas(deps.materializer().state, runtime, input.deltas);
        await deps.appendAndApply([
          runtimePatch(deps.base(), {
            session_id: input.sessionId,
            source: input.source,
            deltas,
            ...(input.causedByMessageId === undefined ? {} : { caused_by_message_id: input.causedByMessageId }),
          }),
        ]);
        return deriveRuntime(deps.materializer().state, input.sessionId);
      }),
  };
}

// ---------------------------------------------------------------- 世界包 / 兼容草稿

export function createPackStore(deps: CardStoreDeps): PackStore {
  return {
    list: () => deps.withReady(async () => listPacks(deps.materializer().state).map((record) => record.pack)),

    save: (pack: WorldPackManifest) =>
      deps.withReady(async () => {
        await deps.appendAndApply([packUpsert(deps.base(), { pack })]);
        const record = deps.materializer().state.packs[pack.id];
        if (record === undefined || record.deleted !== undefined) throw new DataError('store-error', '写入后读不到该世界包');
        return record.pack;
      }),

    remove: (id) =>
      deps.withReady(async () => {
        const record = deps.materializer().state.packs[id];
        if (record === undefined || record.deleted !== undefined) return false;
        await deps.appendAndApply([packDelete(deps.base(), { pack_id: id })]);
        return true;
      }),
  };
}

export function createStashStore(deps: CardStoreDeps): StashStore {
  return {
    list: (characterId) =>
      deps.withReady(async () =>
        liveStash(deps.materializer().state)
          .filter((record) => characterId === undefined || record.entry.character_id === characterId)
          .map((record) => record.entry),
      ),

    save: (entry: CompatStashEntry) =>
      deps.withReady(async () => {
        await deps.appendAndApply([stashUpsert(deps.base(), { entry })]);
        const record = deps.materializer().state.stash[entry.id];
        if (record === undefined || record.deleted !== undefined) throw new DataError('store-error', '写入后读不到该草稿');
        return record.entry;
      }),

    remove: (id) =>
      deps.withReady(async () => {
        const record = deps.materializer().state.stash[id];
        if (record === undefined || record.deleted !== undefined) return false;
        await deps.appendAndApply([stashDelete(deps.base(), { stash_id: id })]);
        return true;
      }),
  };
}

/**
 * 五个存储的集合：op 仓储在 `Repository` 之外把它们的可选性收窄成"必有"，
 * 因此用这个类型一次挂上，避免在 `op-repository.ts` 里重复五遍声明。
 */
export interface CardModelStores {
  readonly cards: CardStore;
  readonly setups: SetupStore;
  readonly runtime: RuntimeStore;
  readonly packs: PackStore;
  readonly stash: StashStore;
}

export function createCardStores(deps: CardStoreDeps): CardModelStores {
  return {
    cards: createCardStore(deps),
    setups: createSetupStore(deps),
    runtime: createRuntimeStore(deps),
    packs: createPackStore(deps),
    stash: createStashStore(deps),
  };
}
