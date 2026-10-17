import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../../../packages/oplog/src/hlc.ts';
import { messageAppend } from '../../../packages/oplog/src/index.ts';
import { toHex } from '../../../packages/oplog/src/bytes.ts';
import { nodeDigest, nodeGzip } from '../../../packages/oplog/src/node-adapters.ts';
import { createBackup, readBackup, type BackupPorts } from '../../../packages/oplog/src/backup.ts';
import type { Op } from '../../../packages/oplog/src/op.ts';
import { setAssetClientForTests, type AssetClient } from '../src/data/asset-client.ts';
import {
  createBackupExporter,
  createBackupExporterWithStats,
  createBackupImporter,
} from '../src/data/op-backup-store.ts';

/**
 * 备份适配器：**整份数据**包含本机资产库（图片）。
 *
 * 四条要钉住：导出把资产写进文件、取不到的资产跳过并计数、
 * 恢复把资产写回本机库、写回后 hash 对不上要跳过并计数（不静默）。
 */

const ports: BackupPorts = { digest: nodeDigest, compressor: nodeGzip };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await nodeDigest.sha256(bytes));
}

function twoOps(): Op[] {
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  const base = { deviceId: 'dev-a', clock };
  return [
    messageAppend(base, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '第一条' }),
    messageAppend(base, { sessionId: 'S1', messageId: 'M2', author: 'character', content: '第二条' }),
  ];
}

interface FakeAssetClient extends AssetClient {
  store: Map<string, Uint8Array>;
}

function fakeAssetClient(options: { failGet?: ReadonlySet<string>; wrongHash?: boolean } = {}): FakeAssetClient {
  const store = new Map<string, Uint8Array>();
  return {
    kind: 'memory',
    available: true,
    persistent: true,
    store,
    async put(bytes) {
      if (options.wrongHash === true) return 'f'.repeat(64);
      const hash = await sha256Hex(bytes);
      if (!store.has(hash)) store.set(hash, bytes);
      return hash;
    },
    async get(hash) {
      if (options.failGet?.has(hash) === true) return undefined;
      return store.get(hash);
    },
    async list() {
      return [...store.keys()].sort();
    },
    async remove(hash) {
      return store.delete(hash);
    },
  };
}

test('导出：本机资产库里的图片进备份（读取回来逐字节相同）', async () => {
  const client = fakeAssetClient();
  const image = Uint8Array.from([137, 80, 78, 71, 1, 2, 3]);
  const hash = await client.put(image);
  client.store.set('orphan-' + '0'.repeat(58), image); // 不合法的 hash 不该进备份
  setAssetClientForTests(client);

  const ops = twoOps();
  const exporter = createBackupExporterWithStats({ loadAll: async () => ops, deviceId: 'dev-a' });
  const result = await exporter(ports);

  assert.equal(result.assets, 1);
  assert.equal(result.assetsSkipped, 1, '不合法 hash 跳过并计数');
  const restored = await readBackup(result.bytes, { ports });
  assert.deepEqual(restored.assets, [{ hash, bytes: image }]);
  assert.deepEqual(restored.ops, ops);
});

test('导出：拿不到的资产跳过并计数，不拖垮整份备份', async () => {
  const client = fakeAssetClient();
  const kept = await client.put(Uint8Array.from([1, 2, 3]));
  const missing = await client.put(Uint8Array.from([4, 5, 6]));
  setAssetClientForTests(client);
  const failing = fakeAssetClient({ failGet: new Set([missing]) });
  failing.store.set(kept, client.store.get(kept) as Uint8Array);
  failing.store.set(missing, client.store.get(missing) as Uint8Array);
  setAssetClientForTests(failing);

  const result = await createBackupExporterWithStats({ loadAll: async () => [] })(ports);
  assert.equal(result.assets, 1);
  assert.equal(result.assetsSkipped, 1);
  const restored = await readBackup(result.bytes, { ports });
  assert.deepEqual(restored.assets.map((asset) => asset.hash), [kept]);

  // 原有签名仍返回 Uint8Array（调用方签名不变）
  const bytes = await createBackupExporter({ loadAll: async () => [] })(ports);
  assert.ok(bytes instanceof Uint8Array);
});

test('恢复：备份里的资产写回本机资产库，op 照旧追加', async () => {
  const image = Uint8Array.from([255, 0, 128, 64]);
  const hash = await sha256Hex(image);
  const ops = twoOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000, assets: [{ hash, bytes: image }] });

  const client = fakeAssetClient();
  setAssetClientForTests(client);
  const stored: Op[] = [];
  const importer = createBackupImporter({
    appendAndApply: async (incoming) => {
      stored.push(...incoming);
    },
    knownOpIds: async () => new Set(stored.map((op) => op.opId)),
  });
  const result = await importer(bytes, ports);

  assert.equal(result.assets, 1);
  assert.equal(result.assetsSkipped, 0);
  assert.deepEqual(client.store.get(hash), image, '恢复后本机资产库里要有这张图');
  assert.deepEqual(stored, ops, 'op 仍然照旧追加');
});

test('恢复：写回 hash 与条目 hash 不一致时跳过并计数（不静默）', async () => {
  const image = Uint8Array.from([9, 8, 7]);
  const hash = await sha256Hex(image);
  const bytes = await createBackup([], { ports, createdAt: 1_700_000_000_000, assets: [{ hash, bytes: image }] });

  setAssetClientForTests(fakeAssetClient({ wrongHash: true }));
  const importer = createBackupImporter({
    appendAndApply: async () => undefined,
    knownOpIds: async () => new Set(),
  });
  const result = await importer(bytes, ports);
  assert.equal(result.assets, 0);
  assert.equal(result.assetsSkipped, 1);
});
