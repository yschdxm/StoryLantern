import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAppend, settingSet } from '../../oplog/src/op.ts';
import { createWorld, emit, freeze, messageIds } from './world.ts';

const A = 'device-a';
const B = 'device-b';
const BASE = 1_700_000_000_000;

test('事故 1：远端段被截断（半上传/网盘吃字节）→ 读侧拒绝、游标不推进、本地不受影响、修复后收敛', async () => {
  const world = createWorld();
  const a = world.peer(A);
  const b = world.peer(B);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: '重要内容' }));
  await world.sync(A);

  const segmentPathUploaded = (await world.backend.list('logs/')).entries[0]?.path;
  assert.ok(segmentPathUploaded, 'A 应当已发布一个段');
  const original = Uint8Array.from(world.backend.files.get(segmentPathUploaded) as Uint8Array);

  // 远端文件被截断
  world.backend.seed(segmentPathUploaded, original.subarray(0, Math.floor(original.length * 0.6)));

  const broken = await world.sync(B);
  assert.ok(
    broken.warnings.some((warning) => warning.includes('段被拒绝')),
    `应告警段被拒绝，实际：${broken.warnings.join(' | ')}`,
  );
  assert.deepEqual(messageIds(b), [], '校验失败的段不得被写入本地');
  assert.equal(Object.keys(b.engine.state.cursors).length, 0, '游标不得推进，否则损坏内容会被当成已消费');
  assert.equal(b.engine.state.outbox.length, 0);

  // 修复远端 → 下一次同步即可收敛
  world.backend.seed(segmentPathUploaded, original);
  await world.sync(B);
  assert.deepEqual(messageIds(b), ['A1']);
  assert.equal(freeze(b), freeze(a));
});

test('事故 2：存储方篡改一个字节 → 完整性校验拒绝，且不污染本地', async () => {
  const world = createWorld();
  const a = world.peer(A);
  const b = world.peer(B);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: '原始内容' }));
  await world.sync(A);

  const uploaded = (await world.backend.list('logs/')).entries[0]?.path as string;
  const tampered = Uint8Array.from(world.backend.files.get(uploaded) as Uint8Array);
  tampered[12] = (tampered[12] as number) ^ 0xff;
  world.backend.seed(uploaded, tampered);

  const result = await world.sync(B);
  assert.ok(result.warnings.some((warning) => /段被拒绝/.test(warning)));
  assert.deepEqual(messageIds(b), []);
  assert.equal(b.engine.state.cursors ? Object.keys(b.engine.state.cursors).length : 0, 0);
});

test('事故 3：manifest 声明有段但远端已缺（GC/误删）→ 告警缺口，仍能拿到后续段并最终收敛', async () => {
  const world = createWorld();
  const a = world.peer(A);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: '第一段' }));
  const first = await world.sync(A);
  assert.equal(first.warnings.length, 0);

  // 删掉已发布的段：manifest 仍会声明它，制造"声明与实物不符"
  const uploaded = (await world.backend.list('logs/')).entries[0]?.path as string;
  world.backend.remove(uploaded);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A2', author: 'user', content: '第二段' }));
  await world.sync(A);

  const b = world.peer(B);
  const result = await world.sync(B);
  assert.ok(
    result.warnings.some((warning) => warning.includes('段被拒绝') || warning.includes('缺少第')),
    `应告警缺段，实际：${result.warnings.join(' | ')}`,
  );
  // 第二段仍然拿到：缺一个段不能阻塞后面的数据
  assert.ok(messageIds(b).includes('A2'));
  assert.equal(b.engine.state.outbox.length, 0);
});

test('事故 4：远端被回滚到旧快照 → 告警且本地绝不回退', async () => {
  const world = createWorld();
  const a = world.peer(A);
  const b = world.peer(B);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: '一' }));
  await world.sync(A);
  await world.sync(B);
  const snapshot = world.backend.snapshot();
  const before = freeze(b);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A2', author: 'user', content: '二' }));
  await world.sync(A);
  await world.sync(B);
  assert.deepEqual(messageIds(b), ['A1', 'A2']);

  // 网盘被还原到旧状态
  world.backend.restore(snapshot);

  const result = await world.sync(B);
  assert.ok(
    result.warnings.some((warning) => warning.includes('回退')),
    `应告警 manifest 回退，实际：${result.warnings.join(' | ')}`,
  );
  assert.deepEqual(messageIds(b), ['A1', 'A2'], '本地数据不得因远端回滚而丢失');
  assert.notEqual(freeze(b), before);
});

test('事故 5：设备时钟相差 5 分钟且随后被人为调回 → 因果顺序仍然正确且两端收敛', async () => {
  const world = createWorld({ clockOffsets: { [A]: 0, [B]: 5 * 60 * 1000 } });
  const a = world.peer(A);
  const b = world.peer(B);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: 'A 先说' }));
  emit(b, messageAppend(b, { sessionId: 'S1', messageId: 'B1', author: 'character', content: 'B 后说' }));

  await world.settle();
  assert.deepEqual(messageIds(a), ['A1', 'B1']);
  assert.deepEqual(messageIds(b), ['A1', 'B1']);

  // A 的墙上时钟被调回 10 分钟；但 A 已观察到 B 的 HLC，新事件必须排在其后
  a.setWallClock(BASE - 10 * 60 * 1000);
  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A2', author: 'user', content: 'A 又说' }));

  await world.settle();
  assert.deepEqual(messageIds(a), ['A1', 'B1', 'A2'], '调慢时钟不得让新消息排到旧消息之前');
  assert.deepEqual(messageIds(b), ['A1', 'B1', 'A2']);
  assert.equal(freeze(a), freeze(b));
});

test('事故 6：离线时同步失败，但本地数据完好，恢复后自动补传', async () => {
  const world = createWorld();
  const a = world.peer(A);

  emit(a, messageAppend(a, { sessionId: 'S1', messageId: 'A1', author: 'user', content: '离线期间写的内容' }));
  world.backend.faults.offline = true;

  await assert.rejects(() => world.sync(A));
  assert.deepEqual(messageIds(a), ['A1'], '离线不得影响本地可用性');
  assert.equal(a.engine.state.outbox.length, 1, '待发布内容保留在 outbox');

  world.backend.faults.offline = false;
  await world.sync(A);
  await world.sync(B);
  assert.deepEqual(messageIds(world.peer(B)), ['A1']);
  assert.equal(freeze(world.peer(B)), freeze(a));
});

test('事故 7：三设备随机离线/恢复的混沌测试最终收敛且 0 丢消息', async () => {
  const world = createWorld({ deviceIds: [A, B, 'device-c'] });
  const ids = [A, B, 'device-c'];
  const order = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];

  // 每台设备各自写下 2 条（互不可见），中间穿插离线窗口
  for (const [index, deviceId] of ids.entries()) {
    const peer = world.peer(deviceId);
    emit(
      peer,
      messageAppend(peer, {
        sessionId: 'S1',
        messageId: order[index * 2] as string,
        author: 'user',
        content: `${deviceId} 写的第一条`,
      }),
    );
    emit(peer, settingSet(peer, { key: `pref.${deviceId}`, value: index }));
  }

  // 随机顺序同步，且每次同步前可能有人离线
  for (let round = 0; round < 6; round += 1) {
    for (const deviceId of ids) {
      const offline = (round + deviceId.length) % 3 === 0;
      world.backend.faults.offline = offline;
      try {
        await world.sync(deviceId);
      } catch {
        // 离线导致的失败是预期内的
      }
    }
  }
  world.backend.faults.offline = false;

  // 补充第二批消息后再收敛
  for (const [index, deviceId] of ids.entries()) {
    const peer = world.peer(deviceId);
    emit(
      peer,
      messageAppend(peer, {
        sessionId: 'S1',
        messageId: order[index * 2 + 1] as string,
        author: 'character',
        content: `${deviceId} 写的第二条`,
      }),
    );
  }
  await world.settle();

  const baseline = freeze(world.peer(A));
  for (const deviceId of ids) {
    assert.equal(freeze(world.peer(deviceId)), baseline, `${deviceId} 未收敛`);
    assert.deepEqual(
      messageIds(world.peer(deviceId)).sort(),
      [...order].sort(),
      `${deviceId} 丢失或重复了消息`,
    );
  }
  assert.equal(world.peer(A).materializer.orphanCount, 0, '不应残留孤儿 op');
});
