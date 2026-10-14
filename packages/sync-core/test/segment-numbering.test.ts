import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAppend } from '../../oplog/src/op.ts';
import { createWorld, emit, messageIds } from './world.ts';

const A = 'device-a';
const B = 'device-b';

/**
 * 段号必须是**每会话**从 1 连续。
 *
 * 这是一次真机上暴露出来的回归：段号原本取自"设备全局计数器"，所以第二个会话的
 * 首段号是 2。接收方按 `1..lastSeq` 逐个找段，于是永远认为第 1 号段缺失——
 * 数据其实同步过去了，但每次同步都报警告，且**水位永远停在 0**（每次都要重新检查）。
 */
test('多会话发布：每个会话的段号都从 1 连续，接收方不该报缺段', async () => {
  const world = createWorld({ snapshotThreshold: 0 });
  const a = world.peer(A);
  const b = world.peer(B);

  const sessions = ['S1', 'S2', 'S3'];
  for (const sessionId of sessions) {
    emit(a, messageAppend(a, { sessionId, messageId: `${sessionId}-1`, author: 'user', content: `${sessionId} 第一句` }));
    emit(a, messageAppend(a, { sessionId, messageId: `${sessionId}-2`, author: 'character', content: `${sessionId} 第二句` }));
  }

  const published = await world.sync(A);
  assert.deepEqual(published.warnings, [], '发布过程不该有告警');

  const hostedList = Object.values(a.engine.state.hosted);
  assert.equal(hostedList.length, sessions.length, '三个会话各有一份发布记录');
  for (const hosted of hostedList) {
    const seqs = Object.keys(hosted.segments).map(Number).sort((left, right) => left - right);
    assert.deepEqual(
      seqs,
      Array.from({ length: seqs.length }, (_, index) => index + 1),
      `段号必须从 1 连续，实际是 ${seqs.join(',')}`,
    );
    assert.equal(hosted.lastSeq, seqs.length);
  }

  const pulled = await world.sync(B);
  assert.deepEqual(
    pulled.warnings.filter((warning) => warning.includes('缺少')),
    [],
    '不该出现"缺少第 N 号段"',
  );
  assert.equal(pulled.appliedOps, sessions.length * 2, '六个 op 都应被应用');
  for (const sessionId of sessions) {
    assert.deepEqual(messageIds(b, sessionId), [`${sessionId}-1`, `${sessionId}-2`]);
  }
});

test('多会话发布：接收方的水位推进到每个会话的最后一段（不会每次都重拉）', async () => {
  const world = createWorld({ snapshotThreshold: 0 });
  const a = world.peer(A);
  const b = world.peer(B);

  for (const sessionId of ['S1', 'S2']) {
    for (let index = 1; index <= 3; index += 1) {
      emit(a, messageAppend(a, { sessionId, messageId: `${sessionId}-${index}`, author: 'user', content: `第 ${index} 句` }));
    }
  }
  await world.sync(A);

  const first = await world.sync(B);
  assert.equal(first.downloaded.length, 2, '两个会话各一段');

  // 再来一轮：什么都不该重新下载
  const second = await world.sync(B);
  assert.deepEqual(second.downloaded, [], '水位已推进，第二次不该重拉');
  assert.deepEqual(second.warnings, []);
});
