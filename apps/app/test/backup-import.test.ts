import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../../../packages/oplog/src/hlc.ts';
import { Materializer } from '../../../packages/oplog/src/materialize.ts';
import { messageAppend } from '../../../packages/oplog/src/index.ts';
import { nodeDigest, nodeGzip } from '../../../packages/oplog/src/node-adapters.ts';
import { createBackup, type BackupPorts } from '../../../packages/oplog/src/backup.ts';
import type { Op } from '../../../packages/oplog/src/op.ts';
import { createBackupExporter, createBackupImporter } from '../src/data/op-backup-store.ts';

/**
 * **恢复**备份（导入 `.slbak`）。
 *
 * 判据有两条，都得有：
 *  1. **恢复出来与原始逐字节相同**（拿 `Materializer.freeze` 比）—— 否则这个备份没用；
 *  2. **重复导入不改状态**（opId 幂等）—— 否则"选错目录/点两次"就会让日志翻倍。
 *
 * 用真的 `Materializer` + 真的 `nodeGzip/nodeDigest` 端口，不搭假货：
 * 这条路上最容易出错的地方恰恰是"序列化 + 压缩 + 摘要"这三件事的组合。
 */

const ports: BackupPorts = { digest: nodeDigest, compressor: nodeGzip };

function twoOps(): { ops: Op[]; freeze: string } {
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  const base = { deviceId: 'dev-a', clock };
  const ops: Op[] = [
    messageAppend(base, { sessionId: 'S1', messageId: 'M1', author: 'user', content: '第一条' }),
    messageAppend(base, { sessionId: 'S1', messageId: 'M2', author: 'character', content: '第二条' }),
  ];
  const materializer = new Materializer();
  materializer.applyAll(ops);
  return { ops, freeze: Materializer.freeze(materializer.snapshot()) };
}

/** 一个最小的"仓储"：只做恢复需要的那两件事。 */
function makeTarget() {
  const materializer = new Materializer();
  return {
    materializer,
    importer: createBackupImporter({
      appendAndApply: async (ops) => {
        materializer.applyAll(ops);
      },
      knownOpIds: async () => new Set(materializer.snapshot().appliedOpIds),
    }),
  };
}

test('恢复：导入备份后，物化状态与原始逐字节相同', async () => {
  const { ops, freeze } = twoOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000, deviceId: 'dev-a' });

  const target = makeTarget();
  const result = await target.importer(bytes, ports);

  assert.equal(result.total, 2);
  assert.equal(result.applied, 2, '全新设备上两条都是新的');
  assert.equal(result.duplicates, 0);
  assert.equal(Materializer.freeze(target.materializer.snapshot()), freeze, '恢复出来的状态必须与原始逐字节相同');
});

test('重复导入幂等：第二次几乎全是重复项，状态不变', async () => {
  const { ops, freeze } = twoOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000 });

  // 用"已存在的 opId"来做幂等判断：先把 op 应用进去，再数一遍
  const materializer = new Materializer();
  const importer = createBackupImporter({
    appendAndApply: async (incoming) => {
      materializer.applyAll(incoming);
    },
    knownOpIds: async () => new Set(materializer.snapshot().appliedOpIds),
  });

  const first = await importer(bytes, ports);
  assert.equal(first.applied, 2);
  const afterFirst = Materializer.freeze(materializer.snapshot());
  assert.equal(afterFirst, freeze);

  const second = await importer(bytes, ports);
  assert.equal(second.total, 2);
  assert.equal(second.applied, 0, '第二次不该有任何新东西');
  assert.equal(second.duplicates, 2);
  assert.equal(Materializer.freeze(materializer.snapshot()), afterFirst, '重复导入不得改变状态');
});

test('导出 → 恢复到一台全新设备 → 状态一致（端到端走一遍）', async () => {
  const { ops, freeze } = twoOps();
  const exporter = createBackupExporter({ loadAll: async () => ops, deviceId: 'dev-a' });
  const bytes = await exporter(ports);

  const target = makeTarget();
  await target.importer(bytes, ports);
  assert.equal(Materializer.freeze(target.materializer.snapshot()), freeze);
});

test('坏文件必须拒绝，且**一条都不写**（不能"导一半"）', async () => {
  const { ops } = twoOps();
  const bytes = await createBackup(ops, { ports, createdAt: 1_700_000_000_000 });
  const tampered = Uint8Array.from(bytes);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;

  const target = makeTarget();
  await assert.rejects(() => target.importer(tampered, ports));
  assert.equal([...target.materializer.snapshot().appliedOpIds].length, 0, '失败时不应写入任何 op');
});
