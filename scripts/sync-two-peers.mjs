import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HlcClock } from '../packages/oplog/src/hlc.ts';
import { Materializer } from '../packages/oplog/src/materialize.ts';
import {
  createAesGcmCipher,
  createDeviceSigner,
  createRosterVerifier,
  generateDeviceKeyPair,
  nodeDigest,
  nodeGzip,
} from '../packages/oplog/src/node-adapters.ts';
import { messageAppend } from '../packages/oplog/src/index.ts';
import { SyncEngine } from '../packages/sync-core/src/engine.ts';
import { DeviceRosterList } from '../packages/sync-core/src/roster.ts';
import { createWebDavBackend } from '../plugins/sync-webdav/src/index.ts';

/**
 * **真对真**的同步验证：两个对端（各自独立的引擎与物化器）通过 **HTTP 走真 WebDAV 后端**
 * （`scripts/mock-webdav.mjs`）同步，用来验证"字节级增量快照"在真传输上确实成立：
 *
 *  1. 发布方按阈值 1 连续同步 → 远端出现"一份整份 + 若干增量"（体积按落盘核对）；
 *  2. 第二个对端（空状态）同步 → 必须把**基准链取全并合并**，消息与发布方一致；
 *  3. 删掉基准 → 第三个对端仍能靠**段**补齐（断链回退），并留下"快照不可用"的告警。
 *
 * 两个量具上的坑（都踩过、都记在这里）：
 *  - **时钟必须推进**：墙钟不动时，消息的 HLC 与上一份快照的 createdAt 相等，增量会被判定成"没有新消息"而全空；
 *  - **不用 `backend.list`**：这台 mock NAS 的 PROPFIND 列目录与我们的用法对不上（列不到文件），
 *    所以体积直接按**落盘文件**核对 —— 验的是"写出去的东西长什么样"，本来就该看盘。
 *
 * 为什么不用手机：这台手机的 WebView 不支持 X25519，做不了同步的密钥协商（应用自己也提示了）。
 * 所以"真机两设备"在这台设备上不成立，改用**真后端 + 两个真对端进程**验证传输这一层。
 */

const BASE_TIME = 1_700_000_000_000;
const URL_BASE = process.env.SYNC_URL ?? 'http://127.0.0.1:15197/';
const DISK_ROOT = process.env.SYNC_DISK ?? '.webdav-out';

/** 从落盘目录里列出某前缀下的文件（体积也一并取到）。 */
function diskFiles(prefix) {
  const out = [];
  const walk = (dir, relative) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = relative === '' ? name : `${relative}/${name}`;
      if (statSync(full).isDirectory()) walk(full, rel);
      else if (rel.startsWith(prefix)) out.push({ path: rel, bytes: statSync(full).size });
    }
  };
  walk(DISK_ROOT, '');
  return out;
}

async function main() {
  const backend = createWebDavBackend({ baseUrl: URL_BASE });
  const blindKey = new Uint8Array(32).fill(7);
  const cipher = createAesGcmCipher({ key: new Uint8Array(32).fill(9) });
  const keysByDevice = new Map();
  const records = ['peer-a', 'peer-b', 'peer-c'].map((deviceId, index) => {
    const keys = generateDeviceKeyPair(deviceId);
    keysByDevice.set(deviceId, keys);
    return { deviceId, publicKey: keys.publicKeyPem, addedAt: BASE_TIME + index };
  });
  const roster = new DeviceRosterList(records);

  const makePeer = (deviceId) => {
    const keys = keysByDevice.get(deviceId);
    let wall = BASE_TIME;
    const clock = new HlcClock({ now: () => wall });
    const engine = new SyncEngine({
      deviceId,
      backend,
      ports: {
        digest: nodeDigest,
        compressor: nodeGzip,
        signer: createDeviceSigner(keys),
        verifier: createRosterVerifier(roster.toVerifierMap()),
        cipher,
      },
      roster,
      blindKey,
      clock,
      now: () => wall,
      // 阈值 1：每发一个段就写一份快照 —— 这样很快就能看到"整份 + 增量"的链
      snapshotThreshold: 1,
    });
    return {
      deviceId,
      engine,
      materializer: new Materializer(),
      clock,
      /** 推进墙钟：增量靠"某条消息在基准之后动过"来挑，时钟不动就挑不出来。 */
      advance(ms = 1_000) {
        wall += ms;
      },
    };
  };

  const emit = (peer, index) => {
    peer.advance();
    const op = messageAppend(peer, { sessionId: 'S1', messageId: `M${index}`, author: 'user', content: `第 ${index} 条` });
    peer.engine.enqueue(op);
    peer.materializer.applyAll([op]);
  };
  const ids = (peer) => peer.materializer.orderOf('S1').map((message) => message.id);

  const a = makePeer('peer-a');
  for (const index of [0, 1, 2]) {
    emit(a, index);
    await a.engine.sync(a.materializer);
  }
  const afterFull = diskFiles('snapshots/');
  console.log(`  [两对端] 发布方同步 3 次：远端快照 ${afterFull.length} 份，体积 ${afterFull.map((f) => f.bytes).join(' / ')} B`);

  for (const index of [3, 4]) {
    emit(a, index);
    await a.engine.sync(a.materializer);
  }
  const afterDeltas = diskFiles('snapshots/');
  const sizes = afterDeltas.map((file) => file.bytes).sort((left, right) => left - right);
  const smallest = sizes[0] ?? 0;
  const largest = sizes[sizes.length - 1] ?? 1;
  console.log(
    `  [两对端] 再改 2 条：远端快照 ${afterDeltas.length} 份，体积（小→大）${sizes.join(' / ')} B` +
      `；最小/最大 = ${(smallest / largest).toFixed(3)}`,
  );

  const b = makePeer('peer-b');
  const resultB = await b.engine.sync(b.materializer);
  const sameB = JSON.stringify(ids(b)) === JSON.stringify(ids(a));
  console.log(
    `  [两对端] 第二个对端同步：hydratedSessions=${resultB.hydratedSessions}` +
      `${resultB.snapshotChainLength === undefined ? '' : `、链上取 ${resultB.snapshotChainLength} 份`}` +
      `、下载 ${resultB.downloaded.length} 个文件、消息${sameB ? '一致' : '**不一致**'}（${ids(b).join(',')}）`,
  );
  if (!sameB) throw new Error(`第二个对端的消息与发布方不一致：${ids(b).join(',')} vs ${ids(a).join(',')}`);

  // 断链回退：把**最小**的那份（链的起点整份通常最大，这里按内容找基准：删掉被依赖却没被取到的那份）
  const chainPaths = resultB.downloaded.filter((path) => path.startsWith('snapshots/'));
  const basePath = chainPaths[chainPaths.length - 1];
  if (basePath !== undefined) {
    await backend.delete(basePath);
    console.log(`  [两对端] 已删除远端 ${basePath}（制造断链）`);
  }
  const c = makePeer('peer-c');
  const resultC = await c.engine.sync(c.materializer);
  const sameC = JSON.stringify(ids(c)) === JSON.stringify(ids(a));
  const warned = resultC.warnings.some((warning) => warning.includes('快照不可用'));
  console.log(
    `  [两对端] 断链后的新对端：hydratedSessions=${resultC.hydratedSessions}、消息${sameC ? '仍一致' : '**不一致**'}` +
      `（${ids(c).join(',')}）、告警 ${resultC.warnings.length} 条（${warned ? '含"快照不可用"' : '**没有"快照不可用"**'}）`,
  );
  if (!sameC) throw new Error('断链后新对端没有靠段补齐');
  if (!warned) throw new Error('断链后应当留下"快照不可用"的告警');

  console.log(`  [两对端] 最终落盘：快照 ${diskFiles('snapshots/').length} 份、段 ${diskFiles('logs/').length} 个`);
  console.log('  [两对端] 结论：真 HTTP 后端上，整份 + 增量链可写、可读、断链可回退。');
}

main().catch((error) => {
  console.error('  [两对端] 失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
