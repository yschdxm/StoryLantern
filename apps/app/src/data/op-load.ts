import { decodeOp } from '../../../../packages/oplog/src/index.ts';
import { describeError } from './error-text.ts';
import type { HlcClock, Op } from '../../../../packages/oplog/src/index.ts';
import { opsFromLegacy } from './op-migration.ts';
import type { LegacyDump, OpLogPort } from './op-types.ts';

/**
 * 从日志读 op 与旧表迁移。单独一个文件：这两件事都属于"把数据搬进物化器"，
 * 与仓储的业务方法（角色/会话/消息…）不是同一类关注点。
 */

/**
 * 按 seq 升序读回日志里的 op。
 *
 * 坏行**隔离**而不是让整个应用起不来：解析失败的只记一条原因，数量会出现在开发者面板里。
 */
export async function loadOps(ops: OpLogPort, after = 0, onCorrupt?: (message: string) => void): Promise<Op[]> {
  const loaded: Op[] = [];
  let cursor = after;
  for (;;) {
    const page = await ops.list(cursor, 1_000);
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      try {
        loaded.push(decodeOp(row.line));
      } catch (cause) {
        onCorrupt?.(`seq=${row.seq}: ${describeError(cause)}`);
      }
    }
    cursor = page.lastSeq;
    if (page.rows.length < 1_000) break;
  }
  return loaded;
}

/** 旧表迁移只在"日志为空且确实有旧数据"时发生一次。 */
export async function migrateLegacyOnce(input: {
  ops: OpLogPort;
  loadLegacy: (() => Promise<LegacyDump | undefined>) | undefined;
  append: (ops: Op[]) => Promise<void>;
  /** 生成 op 需要的身份与时钟（由仓储提供，保证与其它写入同一套）。 */
  base: () => { deviceId: string; clock: HlcClock };
  now: () => number;
}): Promise<boolean> {
  if (input.loadLegacy === undefined) return false;
  if ((await input.ops.stats()).count > 0) return false;
  const dump = await input.loadLegacy();
  if (dump === undefined) return false;
  if (dump.characters.length === 0 && dump.sessions.length === 0 && dump.messages.length === 0) return false;
  await input.append(opsFromLegacy(dump, input.base, input.now));
  return true;
}
