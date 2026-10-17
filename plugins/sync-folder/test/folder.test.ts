import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HlcClock } from '../../../packages/oplog/src/hlc.ts';
import { Materializer } from '../../../packages/oplog/src/materialize.ts';
import { messageAppend, type Op } from '../../../packages/oplog/src/op.ts';
import {
  createAesGcmCipher,
  createDeviceSigner,
  createRosterVerifier,
  generateDeviceKeyPair,
  nodeDigest,
  nodeGzip,
  type DeviceKeyPair,
} from '../../../packages/oplog/src/node-adapters.ts';
import type { CryptoPorts } from '../../../packages/oplog/src/ports.ts';
import { SyncEngine } from '../../../packages/sync-core/src/engine.ts';
import { DeviceRosterList, type DeviceRecord } from '../../../packages/sync-core/src/roster.ts';
import { createFolderBackend } from '../src/index.ts';

interface DeviceHarness {
  deviceId: string;
  engine: SyncEngine;
  materializer: Materializer;
}

function harness(root: string, deviceId: string, keys: DeviceKeyPair, roster: DeviceRosterList, verifierKeys: ReadonlyMap<string, string>, blindKey: Uint8Array): DeviceHarness {
  const cipher = createAesGcmCipher({ key: new Uint8Array(32).fill(9) });
  const ports: CryptoPorts = {
    digest: nodeDigest,
    compressor: nodeGzip,
    signer: createDeviceSigner(keys),
    verifier: createRosterVerifier(verifierKeys),
    cipher,
  };
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  return {
    deviceId,
    engine: new SyncEngine({ deviceId, backend: createFolderBackend({ root }), ports, roster, blindKey, clock }),
    materializer: new Materializer(),
  };
}

test('文件夹后端：两个设备共用同一目录（网盘/NAS 场景）即可完成同步并收敛', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'storylantern-sync-'));
  try {
    const blindKey = new Uint8Array(32).fill(7);
    const keysA = generateDeviceKeyPair('device-a');
    const keysB = generateDeviceKeyPair('device-b');
    const records: DeviceRecord[] = [
      { deviceId: 'device-a', addedAt: 1 },
      { deviceId: 'device-b', addedAt: 2 },
    ];
    const roster = new DeviceRosterList(records);
    const verifierKeys = new Map([['device-a', keysA.publicKeyPem], ['device-b', keysB.publicKeyPem]]);

    const a = harness(root, 'device-a', keysA, roster, verifierKeys, blindKey);
    const b = harness(root, 'device-b', keysB, roster, verifierKeys, blindKey);

    const opA: Op = messageAppend(
      { deviceId: 'device-a', clock: new HlcClock({ now: () => 1_700_000_000_000 }) },
      { sessionId: 'S1', messageId: 'A1', author: 'user', content: '在电脑上写的一句' },
    );
    a.engine.enqueue(opA);
    a.materializer.applyAll([opA]);

    const first = await a.engine.sync(a.materializer);
    assert.equal(first.warnings.length, 0);
    assert.ok(first.uploaded.some((p) => p.startsWith('logs/')));
    assert.ok(first.uploaded.some((p) => p.startsWith('devices/')));

    const second = await b.engine.sync(b.materializer);
    assert.equal(second.warnings.length, 0);
    assert.deepEqual(
      b.materializer.orderOf('S1').map((m) => m.id),
      ['A1'],
    );

    // 反向同步：B 写的消息回到 A
    const opB: Op = messageAppend(
      { deviceId: 'device-b', clock: new HlcClock({ now: () => 1_700_000_000_500 }) },
      { sessionId: 'S1', messageId: 'B1', author: 'character', content: '在手机上回的一句' },
    );
    b.engine.enqueue(opB);
    b.materializer.applyAll([opB]);
    await b.engine.sync(b.materializer);
    await a.engine.sync(a.materializer);

    assert.deepEqual(
      a.materializer.orderOf('S1').map((m) => m.id),
      ['A1', 'B1'],
    );
    assert.equal(
      Materializer.freeze(a.materializer.snapshot()),
      Materializer.freeze(b.materializer.snapshot()),
      '两个设备必须收敛到同一状态',
    );

    // 目录结构必须与协议一致：远端只应有 devices/ 与 logs/，且不留临时文件
    const entries = await readdir(root, { withFileTypes: true });
    const names = entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['devices', 'logs']);
    assert.equal(names.some((name) => name.includes('.tmp-')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('文件夹后端拒绝越出同步目录的路径', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'storylantern-sync-'));
  try {
    const backend = createFolderBackend({ root });
    await assert.rejects(() => backend.get('../../etc/passwd'), /非法同步路径|越界/);
    await assert.rejects(() => backend.put('../escape.txt', new Uint8Array([1])), /非法同步路径|越界/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
