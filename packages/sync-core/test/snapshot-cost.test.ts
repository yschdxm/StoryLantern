import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAppend } from '../../oplog/src/op.ts';
import { createWorld, emit, type World } from './world.ts';

/**
 * 快照成本的可复跑测量（M4 第五项：增量快照）。
 *
 * 背景：快照是"换机只下一次"的关键，但它是**整份会话状态**。阈值控制"攒够多少段才再发一份"，
 * 所以这个测量回答的问题是：**同一段工作量下，阈值越大到底省多少次全量上传、省多少字节。**
 * 代价是另一面的：阈值越大，新设备要重放的段越多（段本身很小，所以这个代价远小于全量上传）。
 *
 * 这里量的是**上传次数**（引擎的 counters.paths 是精确的）与**快照字节数**（取现存那份）。
 */

const A = 'device-a';

/** 逐个 sync，从而为同一会话累积出多个段（与 snapshot-sync.test.ts 同一手法）。 */
async function publishSegments(world: World, count: number, contentLength = 12): Promise<void> {
  const a = world.peer(A);
  for (let index = 0; index < count; index += 1) {
    emit(
      a,
      messageAppend(a, {
        sessionId: 'S1',
        messageId: `M${String(index).padStart(4, '0')}`,
        author: 'user',
        content: `第 ${index} 条历史消息`.padEnd(contentLength, '。'),
      }),
    );
    await world.sync(A);
  }
}

async function snapshotBytes(world: World): Promise<{ count: number; maxBytes: number }> {
  const result = await world.backend.list('snapshots/');
  // 后端条目字段名由实现决定：按 path/key 都试一遍，取不到再从 get 拿长度（不猜就崩过一次）
  const entries = result.entries as unknown as Array<{ path?: string; key?: string; size?: number }>;
  let maxBytes = 0;
  for (const entry of entries) {
    const path = entry.path ?? entry.key;
    if (typeof entry.size === 'number') {
      maxBytes = Math.max(maxBytes, entry.size);
      continue;
    }
    if (path !== undefined) maxBytes = Math.max(maxBytes, (await world.backend.get(path)).length);
  }
  return { count: entries.length, maxBytes };
}

test('快照成本：同一段工作量（24 次发布）在不同阈值下的全量上传次数（如实打印）', async () => {
  const rows: string[] = [];
  for (const threshold of [4, 8, 16]) {
    const world = createWorld({ snapshotThreshold: threshold });
    await publishSegments(world, 24);
    const a = world.peer(A);
    const uploads = a.engine.counters.paths.filter((path) => path.startsWith('snapshots/'));
    const { count, maxBytes } = await snapshotBytes(world);
    const segments = a.engine.counters.paths.filter((path) => path.startsWith('logs/'));
    rows.push(
      `阈值 ${threshold}：全量快照上传 ${uploads.length} 次｜现存 ${count} 份（清理只留最新）｜` +
        `最大一份 ${maxBytes} B｜同时发布了 ${segments.length} 个段`,
    );
    assert.ok(count <= 1, '同一个会话只应留最新一份快照');
  }
  for (const row of rows) console.log('  [快照成本] ' + row);

  // 阈值越大，全量上传次数应当单调不增（这就是"省下来"的定义）
  const counts = rows.map((row) => Number.parseInt(/上传 (\d+) 次/.exec(row)?.[1] ?? '-1', 10));
  assert.ok(counts.every((value) => value >= 0), '要能解析出次数');
  assert.ok(counts[0] !== undefined && counts[2] !== undefined && counts[0] >= counts[2], '阈值变大不该让上传变多');
});

test('快照成本：会话越大，每一份全量快照越贵（1 万条量级用 400 条同风格消息演示）', async () => {
  const world = createWorld({ snapshotThreshold: 4 });
  await publishSegments(world, 400, 80);
  const a = world.peer(A);
  const { maxBytes } = await snapshotBytes(world);
  const uploads = a.engine.counters.paths.filter((path) => path.startsWith('snapshots/'));
  console.log(
    `  [快照成本] 400 条 × 80 字：全量快照上传 ${uploads.length} 次，每份约 ${maxBytes} B ` +
      `（换算到 1 万条量级即"每次多半 MB"，这正是要按增量而不是按次数的理由）`,
  );
  assert.ok(maxBytes > 0, '应当能量到快照字节数');
});
