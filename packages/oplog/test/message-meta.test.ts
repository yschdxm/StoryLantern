import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { messageAppend, messageEdit, type MessageMeta } from '../src/op.ts';
import { Materializer } from '../src/materialize.ts';
import { createBackup, readBackup } from '../src/backup.ts';
import { nodeDigest, nodeGzip } from '../src/node-adapters.ts';

const META: MessageMeta = {
  modelId: 'deepseek-chat',
  modelLabel: 'DeepSeek Chat',
  reasoning: '先想清楚再开口。',
  citations: [
    { index: 1, messageId: '01M000000', resolved: true },
    { index: 9, resolved: false },
  ],
  tokens: { prompt: 128, completion: 64, estimated: false },
  timing: { firstDeltaMs: 120, totalMs: 2400 },
};

function clockAt(ms: number): HlcClock {
  return new HlcClock({ now: () => ms });
}

test('message.append 带 meta / status=stopped：物化后原样读回，状态不是 done', () => {
  const materializer = new Materializer();
  const clock = clockAt(1_700_000_000_000);
  const op = messageAppend(
    { deviceId: 'device-a', clock },
    {
      sessionId: 'S1',
      messageId: 'M1',
      author: 'character',
      content: '写到一半被停下的回复',
      status: 'stopped',
      meta: META,
    },
  );
  materializer.applyAll([op]);

  const record = materializer.state.messages['M1'];
  assert.ok(record !== undefined);
  assert.equal(record.status, 'stopped');
  assert.equal(materializer.statusOf('M1'), 'stopped');
  assert.deepEqual(record.meta, META);
  // 没有字段的旧 op 不受影响
  const legacy = messageAppend(
    { deviceId: 'device-a', clock },
    { sessionId: 'S1', messageId: 'M0', author: 'user', content: '旧消息' },
  );
  materializer.applyAll([legacy]);
  assert.equal(materializer.state.messages['M0']?.meta, undefined);
  assert.equal(materializer.statusOf('M0'), 'done');
});

test('message.edit 把状态改成 stopped：按 HLC 生效，meta 保持 append 时的值', () => {
  const clock = clockAt(1_700_000_000_000);
  const materializer = new Materializer();
  materializer.applyAll([
    messageAppend(
      { deviceId: 'device-a', clock },
      { sessionId: 'S1', messageId: 'M1', author: 'character', content: '正文', meta: META },
    ),
  ]);

  const edit = messageEdit(
    { deviceId: 'device-a', clock },
    {
      messageId: 'M1',
      revisionId: 'M1:r1',
      baseRevisionId: 'M1:r0',
      content: '正文（用户中途停止）',
      status: 'stopped',
    },
  );
  materializer.applyAll([edit]);
  assert.equal(materializer.statusOf('M1'), 'stopped');
  assert.deepEqual(materializer.state.messages['M1']?.meta, META, 'meta 没被 edit 覆盖');
});

test('快照往返：meta 与 stopped 状态不丢（换机恢复后仍能看到思考链/引用/停止）', () => {
  const clock = clockAt(1_700_000_000_000);
  const materializer = new Materializer();
  materializer.applyAll([
    messageAppend(
      { deviceId: 'device-a', clock },
      {
        sessionId: 'S1',
        messageId: 'M1',
        author: 'character',
        content: '带元数据的回复',
        status: 'stopped',
        meta: META,
      },
    ),
    messageAppend(
      { deviceId: 'device-a', clock },
      { sessionId: 'S1', messageId: 'M2', author: 'user', content: '用户消息' },
    ),
  ]);

  const snapshot = materializer.exportSessionSnapshot({
    deviceId: 'device-a',
    blindSessionId: 'b'.repeat(32),
    sessionId: 'S1',
    watermarks: {},
    now: 1_700_000_000_000,
  });
  const fresh = new Materializer();
  fresh.restoreSessionSnapshot(snapshot);

  const restored = fresh.state.messages['M1'];
  assert.ok(restored !== undefined);
  assert.deepEqual(restored.meta, META);
  assert.equal(restored.status, 'stopped');
  assert.equal(fresh.statusOf('M1'), 'stopped');
  assert.equal(fresh.state.messages['M2']?.meta, undefined);
});

test('整体备份：meta 与 stopped 随 op 往返（.slbak 恢复后元数据还在）', async () => {
  const clock = clockAt(1_700_000_000_000);
  const ops = [
    messageAppend(
      { deviceId: 'device-a', clock },
      {
        sessionId: 'S1',
        messageId: 'M1',
        author: 'character',
        content: '写了一半',
        status: 'stopped',
        meta: META,
      },
    ),
  ];
  const ports = { digest: nodeDigest, compressor: nodeGzip };
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000, deviceId: 'device-a' });
  const restored = await readBackup(bytes, { ports });
  assert.deepEqual(restored.ops, ops);

  const rebuilt = new Materializer();
  rebuilt.applyAll(restored.ops);
  assert.deepEqual(rebuilt.state.messages['M1']?.meta, META);
  assert.equal(rebuilt.statusOf('M1'), 'stopped');
});
