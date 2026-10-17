import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, readBackup, BACKUP_MAGIC, BackupError } from '../src/backup.ts';
import { Materializer } from '../src/materialize.ts';
import { messageAppend } from '../src/index.ts';
import { HlcClock } from '../src/hlc.ts';
import { toHex, utf8 } from '../src/bytes.ts';
import { nodeDigest, nodeGzip } from '../src/node-adapters.ts';
import type { CryptoPorts } from '../src/ports.ts';

/**
 * 「导出全部为一个文件」整体备份。
 *
 * 判据不是"能读回来"这么弱 —— 而是：**拿备份重放出来的状态，与原始状态逐字节相同**。
 * 为此用 `Materializer.freeze`（规范化序列化）对比两份物化状态：这才是"备份真的有用"。
 */

const ports: CryptoPorts = { digest: nodeDigest, compressor: nodeGzip };

function sampleOps(): { ops: ReturnType<typeof messageAppend>[]; freeze: string } {
  let wall = 1_700_000_000_000;
  const clock = new HlcClock({ now: () => wall });
  const base = { deviceId: 'dev-a', clock };
  const ops = [
    messageAppend(base, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '第一条' }),
    messageAppend(base, { sessionId: 'S1', messageId: 'M2', author: 'character', content: '第二条' }),
  ];
  wall += 1000;
  const materializer = new Materializer();
  materializer.applyAll(ops);
  return { ops, freeze: Materializer.freeze(materializer.snapshot()) };
}

test('往返：读回来的 op 与写进去的逐条相同', async () => {
  const { ops } = sampleOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000, deviceId: 'dev-a' });
  const restored = await readBackup(bytes, { ports });
  assert.equal(restored.header.opCount, ops.length);
  assert.equal(restored.header.deviceId, 'dev-a');
  assert.deepEqual(restored.ops, ops);
});

test('回放等价（这条才是备份的判据）：用备份重放，状态与原始逐字节相同', async () => {
  const { ops, freeze } = sampleOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000 });

  const restored = await readBackup(bytes, { ports });
  const rebuilt = new Materializer();
  rebuilt.applyAll(restored.ops);
  assert.equal(Materializer.freeze(rebuilt.snapshot()), freeze);
});

test('被改过必须拒绝：翻转一个字节就报摘要不符（不是"读出半个列表"）', async () => {
  const { ops } = sampleOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000 });
  const tampered = Uint8Array.from(bytes);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;

  await assert.rejects(
    () => readBackup(tampered, { ports }),
    (error: unknown) => error instanceof BackupError && (error.reason === 'digest' || error.reason === 'format'),
    '篡改后必须是摘要不符或解压失败，且是 BackupError',
  );
});

test('被截断必须拒绝（传了一半的文件不能当成好的）', async () => {
  const { ops } = sampleOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000 });
  const half = bytes.slice(0, Math.max(1, Math.floor(bytes.length * 0.6)));
  await assert.rejects(() => readBackup(half, { ports }), BackupError);
});

test('魔数不对、版本不对、压缩算法不对：三种都明确失败', async () => {
  const { ops } = sampleOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000 });

  // 换个魔数
  const bogus = await nodeGzip.compress(new TextEncoder().encode('NOT-A-BACKUP\n{"v":1}\n'));
  await assert.rejects(() => readBackup(bogus, { ports }), /魔数不符/);

  // 版本不对：手工拼一个头
  const text = new TextDecoder().decode(await nodeGzip.decompress(bytes));
  const firstBreak = text.indexOf('\n');
  const secondBreak = text.indexOf('\n', firstBreak + 1);
  const headerJson = text.slice(firstBreak + 1, secondBreak);
  const header = JSON.parse(headerJson) as { v: number };
  const bumped = await nodeGzip.compress(
    new TextEncoder().encode(text.replace(headerJson, JSON.stringify({ ...header, v: 99 }))),
  );
  await assert.rejects(() => readBackup(bumped, { ports }), /不支持的备份版本/);

  // 压缩算法不对（读的一方是另一种算法）
  const otherPorts: CryptoPorts = { digest: nodeDigest, compressor: { ...nodeGzip, algorithm: 'brotli' } };
  await assert.rejects(() => readBackup(bytes, { ports: otherPorts }), /压缩算法/);
});

test('空日志也是合法备份（恢复出来是空的，不是报错）', async () => {
  const bytes = await createBackup([], { ports, createdAt: 1_700_000_000_000 });
  const restored = await readBackup(bytes, { ports });
  assert.deepEqual(restored.ops, []);
  assert.equal(restored.header.opCount, 0);
  assert.equal(restored.header.assetCount, 0);
  assert.deepEqual(restored.assets, []);
  assert.equal(restored.header.v, 2);
  assert.equal(BACKUP_MAGIC, 'SLBAK1');
});

// ---------------------------------------------------------------- v2：op + 资产

const ASSET_HASH = 'a'.repeat(64);

/**
 * 手工拼一个备份（可以造出 writer 不会产生的畸形头/畸形 body）。
 * 摘要口径与 `createBackup` 相同：头（digest 置空）+ "\n" + body。
 */
async function packBackup(header: Record<string, unknown>, body: string): Promise<Uint8Array> {
  const canonical = `${JSON.stringify({ ...header, digest: '' })}\n${body}`;
  const digest = toHex(await nodeDigest.sha256(utf8(canonical)));
  const finalHeader = JSON.stringify({ ...header, digest });
  return nodeGzip.compress(utf8(`${BACKUP_MAGIC}\n${finalHeader}\n${body}`));
}

test('v2：op + 资产往返（头里 assetCount、资产字节逐字节相同）', async () => {
  const { ops } = sampleOps();
  const asset = { hash: ASSET_HASH, bytes: Uint8Array.from([0, 1, 2, 255]) };
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000, assets: [asset] });
  const restored = await readBackup(bytes, { ports });
  assert.equal(restored.header.v, 2);
  assert.equal(restored.header.assetCount, 1);
  assert.deepEqual(restored.ops, ops);
  assert.deepEqual(restored.assets, [asset]);
});

test('v2：没有资产也是合法备份（assetCount = 0，assets 为空数组）', async () => {
  const { ops } = sampleOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000 });
  const restored = await readBackup(bytes, { ports });
  assert.equal(restored.header.assetCount, 0);
  assert.deepEqual(restored.assets, []);
  assert.deepEqual(restored.ops, ops);
});

test('v1 兼容：老备份没有 assetCount，读出来 assets 为空且 op 逐条相同', async () => {
  const { ops } = sampleOps();
  const body = ops.map((op) => JSON.stringify(op)).join('\n');
  const bytes = await packBackup(
    { v: 1, createdAt: 1_700_000_000_000, opCount: ops.length, compression: 'gzip' },
    body,
  );
  const restored = await readBackup(bytes, { ports });
  assert.equal(restored.header.v, 1);
  assert.equal(restored.header.assetCount, 0);
  assert.deepEqual(restored.assets, []);
  assert.deepEqual(restored.ops, ops);
});

test('v2 的 assetCount 缺省按 0 处理（body 里没有资产行时接受）', async () => {
  const { ops } = sampleOps();
  const body = ops.map((op) => JSON.stringify(op)).join('\n');
  const bytes = await packBackup(
    { v: 2, createdAt: 1_700_000_000_000, opCount: ops.length, compression: 'gzip' },
    body,
  );
  const restored = await readBackup(bytes, { ports });
  assert.equal(restored.header.assetCount, 0);
  assert.deepEqual(restored.assets, []);
});

test('assetCount 对不上（头声称 1 张、body 里 0 行）→ format 错误', async () => {
  const bytes = await packBackup(
    { v: 2, createdAt: 1_700_000_000_000, opCount: 0, assetCount: 1, compression: 'gzip' },
    '',
  );
  await assert.rejects(
    () => readBackup(bytes, { ports }),
    (error: unknown) => error instanceof BackupError && error.reason === 'format' && /资产/.test(error.message),
  );
});

test('畸形资产行 → format 错误（不是跳过）', async () => {
  const bytes = await packBackup(
    { v: 2, createdAt: 1_700_000_000_000, opCount: 0, assetCount: 1, compression: 'gzip' },
    '{"asset":"not-a-hash","data":""}',
  );
  await assert.rejects(
    () => readBackup(bytes, { ports }),
    (error: unknown) => error instanceof BackupError && error.reason === 'format' && /第 1 条资产/.test(error.message),
  );
});

test('v2 资产内容被改（body 变了、头没变）→ 摘要不符', async () => {
  const { ops } = sampleOps();
  const asset = { hash: ASSET_HASH, bytes: Uint8Array.from([1, 2, 3]) };
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000, assets: [asset] });
  const text = new TextDecoder().decode(await nodeGzip.decompress(bytes));
  const tampered = await nodeGzip.compress(utf8(text.replace('"data":"AQID"', '"data":"AQIE"')));
  await assert.rejects(
    () => readBackup(tampered, { ports }),
    (error: unknown) => error instanceof BackupError && error.reason === 'digest',
  );
});
