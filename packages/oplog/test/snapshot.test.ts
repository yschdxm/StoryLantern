import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { messageAppend, messageEdit, settingSet } from '../src/op.ts';
import { Materializer } from '../src/materialize.ts';
import { SnapshotError, validateSessionSnapshot } from '../src/snapshot.ts';

function setup(count: number) {
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  const ops = Array.from({ length: count }, (_, index) =>
    messageAppend(
      { deviceId: 'device-a', clock },
      {
        sessionId: 'S1',
        messageId: `01M${String(index).padStart(6, '0')}`,
        author: index % 2 === 0 ? 'user' : 'character',
        content: `第 ${index} 段内容`,
      },
    ),
  );
  const materializer = new Materializer();
  materializer.applyAll(ops);
  return { ops, materializer };
}

test('会话快照：导出 → 在全新设备上恢复，消息与顺序一致', () => {
  const { materializer } = setup(20);
  const snapshot = materializer.exportSessionSnapshot({
    deviceId: 'device-a',
    blindSessionId: 'b'.repeat(32),
    sessionId: 'S1',
    watermarks: { 'device-a': 12 },
    now: 1_700_000_000_000,
  });

  assert.equal(snapshot.messages.length, 20);
  assert.deepEqual(snapshot.watermarks, { 'device-a': 12 });

  const fresh = new Materializer();
  const restored = fresh.restoreSessionSnapshot(snapshot);
  assert.deepEqual(restored, { restoredMessages: 20, skippedExisting: 0 });
  assert.deepEqual(
    fresh.orderOf('S1').map((message) => message.id),
    materializer.orderOf('S1').map((message) => message.id),
  );
  assert.equal(Materializer.freeze(fresh.snapshot()), Materializer.freeze(materializer.snapshot()));
});

test('恢复是"本地优先"：已存在的消息绝不被快照覆盖', () => {
  const { materializer, ops } = setup(3);
  const snapshot = materializer.exportSessionSnapshot({
    deviceId: 'device-a',
    blindSessionId: 'b'.repeat(32),
    sessionId: 'S1',
    watermarks: {},
  });

  // 本地已经有更新的编辑
  const clock = new HlcClock({ now: () => 1_700_000_001_000 });
  const local = new Materializer();
  local.applyAll(ops.slice(0, 1));
  local.applyAll([
    messageEdit(
      { deviceId: 'device-a', clock },
      {
        messageId: '01M000000',
        revisionId: '01M000000:r-local',
        baseRevisionId: '01M000000:r0',
        content: '本地更新过的内容',
      },
    ),
  ]);

  const result = local.restoreSessionSnapshot(snapshot);
  assert.equal(result.restoredMessages, 2, '只补缺的两条');
  assert.equal(result.skippedExisting, 1, '已存在的消息被跳过');
  assert.equal(local.textOf('01M000000'), '本地更新过的内容');
});

test('快照覆盖的 op 已标记为已应用：重放同一批 op 全部被去重', () => {
  const { materializer, ops } = setup(5);
  const snapshot = materializer.exportSessionSnapshot({
    deviceId: 'device-a',
    blindSessionId: 'b'.repeat(32),
    sessionId: 'S1',
    watermarks: {},
  });

  const fresh = new Materializer();
  fresh.restoreSessionSnapshot(snapshot);
  const replay = fresh.applyAll(ops);
  assert.equal(replay.applied, 0);
  assert.equal(replay.duplicates, 5);
  assert.equal(fresh.state.messages['01M000000']?.revisions.length, 1, '不得因为重放而产生重复版本');
});

test('快照只含目标会话：其它会话与设置不受影响', () => {
  const { materializer } = setup(2);
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  materializer.applyAll([
    messageAppend(
      { deviceId: 'device-a', clock },
      { sessionId: 'S2', messageId: '02M1', author: 'user', content: '另一个会话' },
    ),
    settingSet({ deviceId: 'device-a', clock }, { key: 'theme', value: 'dark' }),
  ]);

  const snapshot = materializer.exportSessionSnapshot({
    deviceId: 'device-a',
    blindSessionId: 'b'.repeat(32),
    sessionId: 'S1',
    watermarks: {},
  });
  assert.equal(snapshot.messages.every((message) => message.sessionId === 'S1'), true);

  const fresh = new Materializer();
  fresh.restoreSessionSnapshot(snapshot);
  assert.deepEqual(fresh.orderOf('S2'), []);
  assert.equal(fresh.state.settings.theme, undefined, '设置不属于会话快照');
});

test('畸形快照必须整体拒绝', () => {
  assert.throws(() => validateSessionSnapshot(null), SnapshotError);
  // 版本 2 现在是合法的**增量**（相对 base）；"不支持的版本"要用别的号来试。
  assert.throws(() => validateSessionSnapshot({ v: 99 }), /版本/);
  assert.throws(() => validateSessionSnapshot({ v: 2, deviceId: 'a', blindSessionId: 'b', createdAt: 1, watermarks: {}, appliedOpIds: [], messages: [] }), /base/);
  assert.throws(() => validateSessionSnapshot({ v: 1, deviceId: 'a' }), /blindSessionId/);
  assert.throws(
    () => validateSessionSnapshot({ v: 1, deviceId: 'a', blindSessionId: 'b', createdAt: 1, watermarks: { x: 'nope' }, appliedOpIds: [], messages: [] }),
    /水位/,
  );
  assert.throws(
    () => validateSessionSnapshot({ v: 1, deviceId: 'a', blindSessionId: 'b', createdAt: 1, watermarks: {}, appliedOpIds: [], messages: 'nope' }),
    /messages/,
  );
});
