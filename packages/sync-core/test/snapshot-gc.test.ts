import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAppend, sessionDelete } from '../../oplog/src/index.ts';
import { createWorld, emit } from './world.ts';

/**
 * 快照 GC（第五项第二半）。
 *
 * 背景：每次发布快照会顺手删掉**同一个会话**的上一份，所以单个会话是有界的。但**会话被删之后**，
 * 它最后那份快照会永远留在共享目录里 —— 废弃会话攒多了就是长期泄漏。
 *
 * 这里清的是**墓碑会话**的快照。为什么不按"当前状态里还有没有这个会话"清：某台设备可能还没拉到
 * 那个会话的元数据，按"我现在没有"去删就会误删别人正要用的快照；而墓碑是**跟着 op 同步的事实**，
 * 各设备一致，按它清是安全的。
 */

const A = 'device-a';

function dirOf(path: string): string {
  const parts = path.split('/');
  return parts.slice(0, 2).join('/');
}

test('快照 GC：清掉墓碑会话的快照，活着的会话一份都不动', async () => {
  const world = createWorld({ snapshotThreshold: 0 });
  const a = world.peer(A);

  // 两个会话，各发一条消息并各自发布一份快照
  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '活着的那条' }));
  await world.sync(A);
  const kept = await a.engine.publishSnapshot(a.materializer, 'S1');
  assert.ok(kept, 'S1 的快照应当发布成功');

  emit(a, messageAppend(a, { sessionId: 'S2', messageId: 'M2', author: 'user', content: '要被删的那条' }));
  await world.sync(A);
  const doomed = await a.engine.publishSnapshot(a.materializer, 'S2');
  assert.ok(doomed, 'S2 的快照应当发布成功');

  const before = (await world.backend.list('snapshots/')).entries as unknown as Array<{ path?: string; key?: string }>;
  assert.equal(before.length, 2, `删除前应当有两份快照，实际 ${before.length}`);

  // 删掉 S2（写墓碑），再跑一次快照发布会顺手 GC
  emit(a, sessionDelete(a, { sessionId: 'S2' }));
  await world.sync(A);
  await a.engine.publishSnapshot(a.materializer, 'S1');

  const after = (await world.backend.list('snapshots/')).entries as unknown as Array<{ path?: string; key?: string }>;
  const paths = after.map((entry) => entry.path ?? entry.key ?? '');
  const keptDir = dirOf(kept.path);
  const doomedDir = dirOf(doomed.path);
  console.log(`  [快照 GC] 删除前 ${before.length} 份 → 删除后 ${after.length} 份；墓碑那份还在吗：${paths.some((p) => p.startsWith(doomedDir))}`);

  assert.equal(after.length, 1, '只剩活着那个会话的快照');
  assert.equal(paths.some((path) => path.startsWith(keptDir)), true, '活着会话的快照必须原样保留');
  assert.equal(paths.some((path) => path.startsWith(doomedDir)), false, '墓碑会话的快照必须清掉');
});

test('快照 GC：没有墓碑时不列目录、不删任何东西（不为它增加每次同步的开销）', async () => {
  const world = createWorld({ snapshotThreshold: 0 });
  const a = world.peer(A);
  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '一条' }));
  await world.sync(A);
  const first = await a.engine.publishSnapshot(a.materializer, 'S1');
  const second = await a.engine.publishSnapshot(a.materializer, 'S1');
  assert.ok(first && second);

  const after = (await world.backend.list('snapshots/')).entries as unknown as Array<{ path?: string; key?: string }>;
  assert.equal(after.length, 1, '同一会话只留最新一份（这条是既有的清理，不是 GC）');
  assert.equal(dirOf(second.path), dirOf(first.path), '同一会话应当在同一个目录下');
});
