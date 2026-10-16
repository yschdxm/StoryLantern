import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAppend } from '../../oplog/src/op.ts';
import { createWorld, emit, freeze, messageIds } from './world.ts';

const A = 'device-a';
const B = 'device-b';

/** 让 A 逐个 sync，从而为同一会话累积出多个段。 */
async function publishSegments(world: ReturnType<typeof createWorld>, count: number): Promise<void> {
  const a = world.peer(A);
  for (let index = 0; index < count; index += 1) {
    emit(
      a,
      messageAppend(a, {
        sessionId: 'S1',
        messageId: `M${String(index).padStart(3, '0')}`,
        author: 'user',
        content: `第 ${index} 条历史消息`,
      }),
    );
    await world.sync(A);
  }
}

test('首次同步：有快照时只下一次快照，而不是逐段重放历史', async () => {
  const world = createWorld({ snapshotThreshold: 0 }); // 先关掉自动快照，手动控制
  const a = world.peer(A);
  await publishSegments(world, 12);

  const segmentsUploaded = a.engine.counters.paths.filter((path) => path.startsWith('logs/'));
  assert.ok(segmentsUploaded.length >= 12, `A 应当发布了至少 12 个段，实际 ${segmentsUploaded.length}`);

  const snapshot = await a.engine.publishSnapshot(a.materializer, 'S1');
  assert.ok(snapshot, '快照应当发布成功');
  assert.ok(snapshot.path.startsWith('snapshots/'));

  const b = world.peer(B);
  b.engine.counters.listPrefixes.length = 0;
  const result = await world.sync(B);

  assert.equal(result.hydratedSessions, 1, '应当用快照补课');
  assert.equal(result.hydratedMessages, 12, '12 条历史消息应来自快照');
  assert.deepEqual(
    result.downloaded.filter((path) => path.startsWith('logs/')),
    [],
    '不应再逐段下载历史',
  );
  assert.equal(result.downloaded.length, 1, '下载内容应当只有那一份快照');
  assert.deepEqual(messageIds(b), a.materializer.orderOf('S1').map((m) => m.id));
  assert.equal(freeze(b), freeze(a));
  assert.deepEqual(result.warnings, []);
});

test('快照损坏时退回逐段重放，不影响正确性', async () => {
  const world = createWorld({ snapshotThreshold: 0 });
  await publishSegments(world, 6);
  const a = world.peer(A);
  const snapshot = await a.engine.publishSnapshot(a.materializer, 'S1');
  assert.ok(snapshot);

  // 模拟存储方把快照写坏
  world.backend.seed(snapshot.path, new Uint8Array([1, 2, 3, 4]));

  const b = world.peer(B);
  const result = await world.sync(B);

  assert.ok(
    result.warnings.some((warning) => warning.includes('快照不可用')),
    `应告警快照不可用，实际：${result.warnings.join(' | ')}`,
  );
  assert.ok(result.downloaded.some((path) => path.startsWith('logs/')), '应退回逐段下载');
  assert.deepEqual(messageIds(b).length, 6);
  assert.equal(freeze(b), freeze(a), '退路也必须收敛到同一状态');
});

test('自动快照：段数达到阈值即自动发布（无需用户操作）', async () => {
  const world = createWorld({ snapshotThreshold: 2 });
  const a = world.peer(A);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M0', author: 'user', content: '一' }));
  const first = await world.sync(A);
  assert.equal(first.uploaded.some((path) => path.startsWith('snapshots/')), false, '阈值未到不写快照');

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '二' }));
  const second = await world.sync(A);
  assert.equal(second.uploaded.some((path) => path.startsWith('snapshots/')), true, '达到阈值应自动写快照');
  assert.ok(a.engine.state.hosted[Object.keys(a.engine.state.hosted)[0] as string]?.snapshot !== undefined);

  // 新设备应当直接用快照
  const b = world.peer(B);
  const pulled = await world.sync(B);
  assert.equal(pulled.hydratedSessions, 1);
  assert.deepEqual(messageIds(b), ['M0', 'M1']);
});

test('懒加载：shouldPull 之外的会话本轮完全不拉（不下载、不补课）', async () => {
  const world = createWorld({ snapshotThreshold: 0, shouldPull: () => false });
  await publishSegments(world, 3);
  const a = world.peer(A);
  await a.engine.publishSnapshot(a.materializer, 'S1');

  const b = world.peer(B);
  const result = await world.sync(B);
  assert.deepEqual(result.downloaded, []);
  assert.equal(result.hydratedSessions, 0);
  assert.deepEqual(messageIds(b), []);
});
test('增量快照：第二份是相对第一份的增量，基准**必须留着**（否则谁也还原不了）', async () => {
  // 阈值 1：每发一个段就触发一次快照，便于观察"新旧两份的关系"
  const world = createWorld({ snapshotThreshold: 1 });
  const a = world.peer(A);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M0', author: 'user', content: '一' }));
  await world.sync(A);
  const blind = Object.keys(a.engine.state.hosted)[0] as string;
  const firstHash = a.engine.state.hosted[blind]?.snapshot?.hash;
  assert.ok(firstHash !== undefined, '第一份快照应当已发布');
  const firstPath = 'snapshots/' + blind + '/' + firstHash + '.json.gz';
  assert.equal(world.backend.files.has(firstPath), true, '第一份快照应当在存储里');
  assert.equal(a.engine.state.hosted[blind]?.snapshot?.chainLength, 0, '第一份是整份，链长 0');

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '二' }));
  await world.sync(A);
  const snapshotRef = a.engine.state.hosted[blind]?.snapshot;
  assert.ok(snapshotRef !== undefined && snapshotRef.hash !== firstHash, '第二份快照应当是另一个内容地址');
  assert.equal(snapshotRef.chainLength, 1, '第二份应当是接在整份后面的**增量**');
  const secondPath = 'snapshots/' + blind + '/' + snapshotRef.hash + '.json.gz';
  assert.equal(world.backend.files.has(secondPath), true, '新快照在');
  assert.equal(
    world.backend.files.has(firstPath),
    true,
    '基准必须留着：增量要靠它才能还原（旧策略"只留最新一份"在增量下会直接把链弄断）',
  );

  const snapshotFiles = [...world.backend.files.keys()].filter((path) => path.startsWith('snapshots/'));
  assert.equal(snapshotFiles.length, 2, '基准 + 一份增量 = 2 份，实际 ' + snapshotFiles.length + ' 份');

  // 再把链接到上限（snapshot-publish.ts 里的 MAX_DELTA_CHAIN = 12）之外，应当改发整份并清旧链
  for (let index = 2; index <= 13; index += 1) {
    emit(a, messageAppend(a, { sessionId: 'S1', messageId: `M${index}`, author: 'user', content: `${index}` }));
    await world.sync(A);
  }
  const finalRef = a.engine.state.hosted[blind]?.snapshot;
  assert.equal(finalRef?.chainLength, 0, '链到上限后应当发一份整份收口（链长归零）');
  const afterCap = [...world.backend.files.keys()].filter((path) => path.startsWith('snapshots/'));
  assert.equal(afterCap.length, 1, '整份取代整条链：该会话下只剩这一份，实际 ' + afterCap.length + ' 份');
  console.log('  增量快照：链上 2 份 → 到 12 段上限后整份收口，只剩 1 份');
});

test('断链回退：基准被删掉后，新设备仍能靠段把状态补齐（并留下告警）', async () => {
  const world = createWorld({ snapshotThreshold: 1 });
  const a = world.peer(A);
  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M0', author: 'user', content: '一' }));
  await world.sync(A);
  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '二' }));
  await world.sync(A);

  const blind = Object.keys(a.engine.state.hosted)[0] as string;
  const ref = a.engine.state.hosted[blind]?.snapshot;
  assert.equal(ref?.chainLength, 1, '此时远端应当是"整份 + 一份增量"');
  // 把**基准**删掉 —— 增量就成了没人能还原的孤儿（GC 误删、对端清理过头都会这样）
  const before = [...world.backend.files.keys()].filter((path) => path.startsWith('snapshots/'));
  assert.equal(before.length, 2);
  for (const path of before) {
    if (path === 'snapshots/' + blind + '/' + ref?.hash + '.json.gz') continue;
    world.backend.files.delete(path);
  }

  const b = world.peer(B);
  const result = await world.sync(B);
  assert.deepEqual(messageIds(b), ['M0', 'M1'], '断链也必须靠段把状态补齐（快照只是优化）');
  assert.equal(result.hydratedSessions, 0, '快照没被采用（不能拿残缺的链还原出半个状态）');
  assert.equal(
    result.warnings.some((warning) => warning.includes('快照不可用')),
    true,
    '必须留下"快照不可用（退回逐段重放）"的告警，而不是静默降级',
  );
  console.log('  断链回退：基准被删后 hydratedSessions=0、消息仍为 ' + JSON.stringify(messageIds(b)));
});
