import {
  HlcClock,
  Materializer,
  characterDelete,
  characterUpsert,
  checkpointOp,
  decodeOp,
  encodeOp,
  messageAppend,
  sessionCreate,
  sessionDelete,
  stateDigest,
  ulid,
  type Op,
  type Snapshot,
} from '../../../../packages/oplog/src/index.ts';
import { pickOpening } from './greeting.ts';
import { createLoreStore } from './op-lore-store.ts';
import { createMessageStore } from './op-message-store.ts';
import { createMemoryStore } from './op-memory-store.ts';
import { createTunerStore, type TunerStore } from './op-tuner-store.ts';
import { createBackupExporter } from './op-backup-store.ts';
import { createSummaryStore } from './op-summary-store.ts';
import { createFactStore } from './op-fact-store.ts';
import { loadOps, migrateLegacyOnce } from './op-load.ts';
import type { DeviceStore } from './op-ports.ts';
import { buildSnapshot, clearSnapshot as clearStoredSnapshot, prepareSnapshot } from './op-snapshot.ts';
import type { LegacyDump, OpLogPort, OpLogRepositoryOptions, OpLogStats } from './op-types.ts';
import { characterView, lorebookView, messageView, sessionView } from './op-views.ts';
import {
  DataError,
  type CharacterStore,
  type LorebookStore,
  type MemoryStore,
  type MessageStore,
  type ProbeInfo,
  type Repository,
  type SessionStore,
  type SettingsStore,
} from './repository.ts';
import type { CharacterDraft, Message, Session } from './types.ts';

/**
 * **op-log 仓储**：M1 之后的唯一写入路径。
 *
 * 顺序永远是"先把 op 落盘 → 再改动内存里的物化状态"，因此：
 *  - 日志是唯一事实源；内存里的可读状态**完全可由日志重建**（`rebuild()` 就是干这个）；
 *  - 崩溃/断电只会丢掉"已经写进日志但没有反映到内存"的那一点，重启重放即可；
 *  - 同步就是把这些 op 行搬到别的设备，同一套收敛规则保证结果一致。
 *
 * 设备配置（模型密钥、主题、语言）**不进 op 日志**：密钥不该离开本机，
 * 主题/语言属于设备偏好而非共享内容。
 */

export type { LegacyDump, OpLine, OpLogPort, OpLogStats } from './op-types.ts';

export interface OpLogRepository extends Repository {
  /** 初始化（读日志 + 必要时迁移）完成。 */
  ready: Promise<void>;
  /** 丢掉内存状态、从日志完整重放一遍：证明"读模型是派生的"。 */
  rebuild(): Promise<{ ops: number; characters: number; sessions: number; messages: number }>;
  /** 日志与隔离统计（开发者面板用）。 */
  logStats(): Promise<OpLogStats>;
  /** 实体数量（从物化状态取，也就是从日志派生）；开发者面板显示"真实数据量"用。 */
  counts(): Promise<{ characters: number; sessions: number; messages: number }>;
  /** 生成冷启动快照（设备本地；日志不动）。 */
  createSnapshot(): Promise<{ upToHlc: { t: number; c: number }; opCount: number; digest: string; lastSeq: number }>;
  /** 丢掉快照（下次启动回到全量重放；调试与"快照疑似有问题"时用）。 */
  clearSnapshot(): Promise<void>;
  /** 同步推送用：读本地日志里 `seq > after` 的 op。 */
  exportOps(after: number): Promise<{ ops: Op[]; lastSeq: number }>;
  /** 同步拉取用：把远端 op 并进本地日志与物化状态（按 opId 幂等）。 */
  importOps(ops: readonly Op[]): Promise<{ appended: number; duplicates: number }>;
  /**
   * 同步引擎需要**同一份**物化状态（它会把拉到的 op 应用进来）。
   * 用函数而不是属性：`rebuild()` 会换成新的物化器，属性会拿到过期引用。
   */
  currentMaterializer(): Materializer;
}

export function createOpLogRepository(options: OpLogRepositoryOptions): OpLogRepository {
  const clock = new HlcClock(options.now === undefined ? {} : { now: options.now });
  let deviceId = typeof options.deviceId === 'string' ? options.deviceId : '';
  const base = (): { deviceId: string; clock: HlcClock } => ({ deviceId, clock });
  const now = (): number => options.now?.() ?? Date.now();
  let materializer = new Materializer();
  const corrupt: string[] = [];
  /** 上次冷启动走的哪条路（如实展示；"没有快照"和"快照坏了"要能分辨）。 */
  let loadMode: 'snapshot' | 'replay' = 'replay';
  let loadProblem: string | undefined;
  let loadMs = 0;
  let loadCovered = 0;
  let loadTail = 0;

  /** 读日志（坏行隔离）；`after` 用于"载入快照后只追平尾巴"。 */
  const loadAll = (after = 0): Promise<Op[]> => loadOps(options.ops, after, (m) => corrupt.push(m));

  const appendAndApply = async (ops: Op[]): Promise<void> => {
    if (ops.length === 0) return;
    // 先落盘：这样"界面上看到的"永远不超已经持久化的范围
    await options.ops.append(ops.map((op) => encodeOp(op)));
    for (const op of ops) materializer.apply(op);
  };

  const migrateLegacy = (): Promise<boolean> =>
    migrateLegacyOnce({ ops: options.ops, loadLegacy: options.loadLegacy, append: appendAndApply, base, now });

  const ready = (async () => {
    // 设备 id 要先生成/读出来：op 里带着它，同步时才知道"这条是谁写的"
    if (typeof options.deviceId !== 'string') deviceId = await options.deviceId();
    await migrateLegacy();
    const startedAt = performance.now();

    // 1) 先试快照：从 lastSeq 之后接着重放，冷启动不必从头读整份日志
    const loaded = await prepareSnapshot(options.device, options.ops, options.snapshotMinOps);
    let tailAfter = 0;
    if (loaded.snapshot === undefined) {
      loadProblem = loaded.problem;
    } else {
      // `Snapshot` 只用来把状态灌进物化器；appliedOpIds 留空：尾巴的 op 都在快照之后，重复投递也幂等
      const seeded: Snapshot = { version: 1, state: loaded.snapshot.state, appliedOpIds: [] };
      materializer = new Materializer(seeded);
      tailAfter = loaded.snapshot.lastSeq;
      loadCovered = loaded.snapshot.opCount;
      loadMode = 'snapshot';
    }

    // 2) 载入快照后必须继续追平尾巴；没有快照就全量重放
    const tail = await loadAll(tailAfter);
    materializer.applyAll(tail);
    loadTail = tail.length;
    loadMs = Math.round(performance.now() - startedAt);
  })();

  const withReady = async <T>(action: () => Promise<T>): Promise<T> => {
    await ready;
    return action();
  };

  // ---------------------------------------------------------------- 读取（全部派生自物化状态）

  const characters: CharacterStore = {
    list: () => withReady(async () => materializer.characters().map(characterView)),

    get: (id) =>
      withReady(async () => {
        const record = materializer.state.characters[id];
        if (record === undefined || record.deleted !== undefined) return undefined;
        return characterView(record);
      }),

    save: (draft: CharacterDraft) =>
      withReady(async () => {
        const name = (draft.name ?? '').trim();
        if (name === '') throw new DataError('invalid-argument', '角色名不能为空');
        if (name.length > 60) throw new DataError('invalid-argument', '角色名过长（最多 60 字）');
        const id = draft.id ?? ulid();
        if (draft.id !== undefined) {
          const existing = materializer.state.characters[draft.id];
          if (existing === undefined || existing.deleted !== undefined) {
            throw new DataError('invalid-argument', '找不到该角色');
          }
        }
        await appendAndApply([
          characterUpsert(base(), {
            characterId: id,
            name,
            description: (draft.description ?? '').trim(),
            personality: (draft.personality ?? '').trim(),
            scenario: (draft.scenario ?? '').trim(),
            firstMessage: (draft.firstMessage ?? '').trim(),
            exampleDialogue: (draft.exampleDialogue ?? '').trim(),
            // 以前没写进 op：物化是整体覆盖，于是每次保存都会把它们抹掉（界面能编辑、能"保存成功"，读回来却是空）
            systemPrompt: (draft.systemPrompt ?? '').trim(),
            alternateGreetings: (draft.alternateGreetings ?? []).map((item) => item.trim()).filter((item) => item !== ''),
          }),
        ]);
        const record = materializer.state.characters[id];
        if (record === undefined) throw new DataError('store-error', '写入后读不到该角色');
        return characterView(record);
      }),

    remove: (id) =>
      withReady(async () => {
        const existing = materializer.state.characters[id];
        if (existing === undefined || existing.deleted !== undefined) return false;
        // 级联：角色没了，它的会话也一起墓碑（消息随会话失效，不必逐条写 op）
        const ops: Op[] = [characterDelete(base(), { characterId: id })];
        for (const session of materializer.sessions()) {
          if (session.characterId === id) ops.push(sessionDelete(base(), { sessionId: session.id }));
        }
        await appendAndApply(ops);
        return true;
      }),
  };

  const sessions: SessionStore = {
    list: () =>
      withReady(async () =>
        materializer
          .sessions()
          .map((record) => sessionView(materializer, record.id))
          .filter((session): session is Session => session !== undefined)
          .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id)),
      ),

    create: (characterId, title, greetingIndex) =>
      withReady(async () => {
        const character = materializer.state.characters[characterId];
        if (character === undefined || character.deleted !== undefined) {
          throw new DataError('invalid-argument', `角色 ${characterId} 不存在`);
        }
        const clean = (title ?? '').trim();
        if (clean !== '' && clean.length > 120) throw new DataError('invalid-argument', '会话名过长');
        const id = ulid();
        const ops: Op[] = [
          sessionCreate(base(), { sessionId: id, title: clean === '' ? character.name : clean, characterId }),
        ];
        // 开场白随会话一起落地：界面上"新建会话"就该看到那句话选哪一条由 greetingIndex 决定（-1 = 不插入），规则与内存实现共用 pickOpening
        const opening = pickOpening(character, greetingIndex);
        if (opening !== undefined) {
          ops.push(
                        messageAppend(base(), { sessionId: id, messageId: ulid(), author: 'character', content: opening, }),
          );
        }
        await appendAndApply(ops);
        const view = sessionView(materializer, id);
        if (view === undefined) throw new DataError('store-error', '创建会话后读不到它');
        return view;
      }),

    rename: (id, title) =>
      withReady(async () => {
        const clean = title.trim();
        if (clean === '') throw new DataError('invalid-argument', '会话名不能为空');
        const existing = materializer.state.sessions[id];
        if (existing === undefined || existing.deleted !== undefined) return false;
        await appendAndApply([
          sessionCreate(base(), {
            sessionId: id,
            title: clean,
            ...(existing.characterId === undefined ? {} : { characterId: existing.characterId }),
          }),
        ]);
        return true;
      }),

    remove: (id) =>
      withReady(async () => {
        const existing = materializer.state.sessions[id];
        if (existing === undefined || existing.deleted !== undefined) return false;
        await appendAndApply([sessionDelete(base(), { sessionId: id })]);
        return true;
      }),
  };
  const messages: MessageStore = createMessageStore({
    withReady,
    materializer: () => materializer,
    appendAndApply,
    base,
  });
;
  const lorebooks: LorebookStore = createLoreStore({
    withReady,
    materializer: () => materializer,
    appendAndApply,
    base,
  });
  const summaries = createSummaryStore({ withReady, materializer: () => materializer, appendAndApply, base });
  const facts = createFactStore({ withReady, materializer: () => materializer, appendAndApply, base });
  // 记忆与调优助手共用同一套依赖：于是"应用建议"走的就是普通本地写入那条路
  const memories: MemoryStore = createMemoryStore({ withReady, materializer: () => materializer, appendAndApply, base });
  const tuner: TunerStore = createTunerStore({ withReady, materializer: () => materializer, appendAndApply, base });
  const liveMessageCount = (): number =>
    Object.values(materializer.state.messages).filter((message) => message.deleted === undefined).length;
  return {
    kind: 'host',
    ready,
    characters,
    sessions,
    messages,
    lorebooks, memories, tuner, summaries, facts,
    // 设备配置不进 op 日志：密钥不该离开本机，主题/语言属于设备偏好
    settings: options.settings,

    /** 「导出全部为一个文件」：整份 op 日志 → 自包含备份（实现见 op-backup-store.ts）。 */
    exportBackup: createBackupExporter({ loadAll, ...(deviceId === undefined ? {} : { deviceId }) }),

    async rebuild() {
      await ready;
      const ops = await loadAll();
      materializer = new Materializer();
      const result = materializer.applyAll(ops);
      return {
        ops: result.applied + result.duplicates,
        characters: materializer.characters().length,
        sessions: materializer.sessions().length,
        messages: liveMessageCount(),
      };
    },

    async logStats() {
      await ready;
      return {
        ...(await options.ops.stats()),
        corrupt: corrupt.length,
        load: {
          mode: loadMode,
          ms: loadMs,
          covered: loadCovered,
          tail: loadTail,
          ...(loadProblem === undefined ? {} : { problem: loadProblem }),
        },
      };
    },

    /**
     * 生成快照：把当前物化状态写进**设备本地**的 kv，并在日志里留一条 `log.checkpoint`。
     *
     * 刻意**不截断日志**：日志仍是唯一事实源，快照只是让下次冷启动少重放一段。
     * 回收旧日志（截断）是另一件事，必须先有"截断前校验 + 安全余量"的设计。
     */
    async createSnapshot() {
      await ready;
      if (options.device === undefined) throw new DataError('store-error', '没有设备本地存储，无法生成快照');
      return buildSnapshot({
        device: options.device,
        ops: options.ops,
        deviceId,
        state: materializer.state,
        now,
        ...(options.snapshotMinOps === undefined ? {} : { minOps: options.snapshotMinOps }),
        // 检查点由仓储落盘并应用（与其它写入同一条规则：先落盘，再改内存）
        appendCheckpoint: (payload) => appendAndApply([checkpointOp(base(), payload)]),
      });
    },
    async clearSnapshot() {
      await ready;
      if (options.device === undefined) return;
      await clearStoredSnapshot(options.device);
    },

    async exportOps(after) {
      await ready;
      const ops: Op[] = [];
      let cursor = after;
      for (;;) {
        const page = await options.ops.list(cursor, 1_000);
        if (page.rows.length === 0) break;
        for (const row of page.rows) {
          try {
            ops.push(decodeOp(row.line));
          } catch {
            // 坏行在启动时已经记过一次，这里跳过即可
          }
        }
        cursor = page.lastSeq;
        if (page.rows.length < 1_000) break;
      }
      return { ops, lastSeq: cursor };
    },

    async importOps(ops) {
      await ready;
      if (ops.length === 0) return { appended: 0, duplicates: 0 };
      // 先落盘再改内存：与本地写入同一条规则
      const outcome = await options.ops.append(ops.map((op) => encodeOp(op)));
      materializer.applyAll(ops);
      return { appended: outcome.appended, duplicates: outcome.duplicates };
    },

    async counts() {
      await ready;
      return {
        characters: materializer.characters().length,
        sessions: materializer.sessions().length,
        messages: liveMessageCount(),
      };
    },

    currentMaterializer: () => materializer,

    async probe(): Promise<ProbeInfo> {
      await ready;
      const stats = await options.ops.stats();
      return {
        path: `op 日志 ${stats.count} 条 · ${Math.round(stats.bytes / 1024)} KB`,
        journalMode: 'op-log',
        pageSize: 0,
        sqliteVersion: `${stats.devices} 台设备`,
        writable: true,
        characters: materializer.characters().length,
        sessions: materializer.sessions().length,
        messages: liveMessageCount(),
      };
    },
  };
}
