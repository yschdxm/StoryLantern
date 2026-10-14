import {
  HlcClock,
  Materializer,
  characterDelete,
  characterUpsert,
  decodeOp,
  encodeOp,
  messageAppend,
  messageDelete,
  messageEdit,
  sessionCreate,
  sessionDelete,
  ulid,
  type Op,
} from '../../../../packages/oplog/src/index.ts';
import { opsFromLegacy } from './op-migration.ts';
import type { LegacyDump, OpLogPort, OpLogStats } from './op-types.ts';
import { authorOf, characterView, messageView, sessionView } from './op-views.ts';
import {
  DataError,
  validateMessageRole,
  type CharacterStore,
  type MessageStore,
  type ProbeInfo,
  type Repository,
  type SessionStore,
  type SettingsStore,
} from './repository.ts';
import type { CharacterDraft, Message, MessageStatus, Session } from './types.ts';

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

export interface OpLogRepositoryOptions {
  ops: OpLogPort;
  /** 设备 id：可以直接给，也可以异步解析（首次运行要生成并持久化它）。 */
  deviceId: string | (() => Promise<string>);
  settings: SettingsStore;
  /** 日志还是空的且有旧表数据时，用这个把它们转成 op。 */
  loadLegacy?: () => Promise<LegacyDump | undefined>;
  now?: () => number;
}

export function createOpLogRepository(options: OpLogRepositoryOptions): OpLogRepository {
  const clock = new HlcClock(options.now === undefined ? {} : { now: options.now });
  let deviceId = typeof options.deviceId === 'string' ? options.deviceId : '';
  const base = (): { deviceId: string; clock: HlcClock } => ({ deviceId, clock });
  const now = (): number => options.now?.() ?? Date.now();
  let materializer = new Materializer();
  const corrupt: string[] = [];

  const loadAll = async (): Promise<Op[]> => {
    const ops: Op[] = [];
    let after = 0;
    for (;;) {
      const page = await options.ops.list(after, 1_000);
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        try {
          ops.push(decodeOp(row.line));
        } catch (cause) {
          // 隔离而不是让整个应用起不来；数量会出现在开发者面板里
          corrupt.push(`seq=${row.seq}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      after = page.lastSeq;
      if (page.rows.length < 1_000) break;
    }
    return ops;
  };

  const appendAndApply = async (ops: Op[]): Promise<void> => {
    if (ops.length === 0) return;
    // 先落盘：这样"界面上看到的"永远不超已经持久化的范围
    await options.ops.append(ops.map((op) => encodeOp(op)));
    for (const op of ops) materializer.apply(op);
  };

  /** 旧表迁移只在"日志为空且确实有旧数据"时发生一次。 */
  const migrateLegacy = async (): Promise<void> => {
    if (options.loadLegacy === undefined) return;
    if ((await options.ops.stats()).count > 0) return;
    const dump = await options.loadLegacy();
    if (dump === undefined) return;
    if (dump.characters.length === 0 && dump.sessions.length === 0 && dump.messages.length === 0) return;
    await appendAndApply(opsFromLegacy(dump, base, now));
  };

  const ready = (async () => {
    // 设备 id 要先生成/读出来：op 里带着它，同步时才知道"这条是谁写的"
    if (typeof options.deviceId !== 'string') deviceId = await options.deviceId();
    await migrateLegacy();
    materializer = new Materializer();
    materializer.applyAll(await loadAll());
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

    create: (characterId, title) =>
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
        // 开场白随会话一起落地：界面上"新建会话"就该看到那句话
        if (character.firstMessage.trim() !== '') {
          ops.push(
            messageAppend(base(), {
              sessionId: id,
              messageId: ulid(),
              author: 'character',
              content: character.firstMessage.trim(),
            }),
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

  const messages: MessageStore = {
    list: (sessionId) =>
      withReady(async () => {
        const session = materializer.state.sessions[sessionId];
        if (session === undefined || session.deleted !== undefined) return [];
        return materializer
          .orderOf(sessionId)
          .map((record) => messageView(materializer, record.id))
          .filter((message): message is Message => message !== undefined);
      }),

    append: (sessionId, role, content, status: MessageStatus = 'done', createdAt?: number) =>
      withReady(async () => {
        // 与其它实现保持同样的校验（未知角色要报 invalid-argument，而不是写进日志）
        const safeRole = validateMessageRole(role);
        const id = ulid();
        await appendAndApply([
          messageAppend(
            base(),
            {
              sessionId,
              messageId: id,
              author: authorOf(safeRole),
              content,
              ...(status === 'error' ? { status: 'error' as const } : {}),
            },
            // 导入历史时保留原始时间；其余情况用本机时钟
            createdAt === undefined || createdAt <= 0 ? {} : { hlc: { t: createdAt, c: 0 } },
          ),
        ]);
        const view = messageView(materializer, id);
        if (view === undefined) throw new DataError('store-error', '写入后读不到该消息');
        return view;
      }),

    update: (id, content, status: MessageStatus = 'done') =>
      withReady(async () => {
        const record = materializer.state.messages[id];
        if (record === undefined || record.deleted !== undefined) return false;
        await appendAndApply([
          messageEdit(base(), {
            messageId: id,
            revisionId: `${id}:r${record.revisions.length}`,
            baseRevisionId: record.activeRevision.revisionId,
            content,
            status: status === 'error' ? 'error' : 'done',
          }),
        ]);
        return true;
      }),

    remove: (id) =>
      withReady(async () => {
        const record = materializer.state.messages[id];
        if (record === undefined || record.deleted !== undefined) return false;
        await appendAndApply([messageDelete(base(), { messageId: id })]);
        return true;
      }),
  };

  const liveMessageCount = (): number =>
    Object.values(materializer.state.messages).filter((message) => message.deleted === undefined).length;

  return {
    kind: 'host',
    ready,
    characters,
    sessions,
    messages,
    // 设备配置不进 op 日志：密钥不该离开本机，主题/语言属于设备偏好
    settings: options.settings,

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
      return { ...(await options.ops.stats()), corrupt: corrupt.length };
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
