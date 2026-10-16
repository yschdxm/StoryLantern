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
 * （`scripts/mock-webdav.mjs`）同步。可以当脚本跑，也可以被 `sync-capability-matrix.mjs` import 复用。
 *
 * 验四件事：
 *  1. 发布方按阈值 1 连续同步 → 远端出现"一份整份 + 若干增量"；
 *  2. 第二个对端（空状态）同步 → 必须把**基准链取全并合并**，消息与发布方一致；
 *  3. 删掉基准 → 第三个对端仍能靠**段**补齐（断链回退），并留下"快照不可用"的告警；
 *  4. 顺带打印**能力探测**结果（条件写 / 范围读 / 删除），这是降级档位的判据。
 *
 * 两个量具上的坑（都踩过、都记着）：
 *  - **时钟必须推进**：墙钟不动时，消息的 HLC 与上一份快照的 createdAt 相等，增量会被判定成"没有新消息"而全空；
 *  - **不用 `backend.list` 核对体积**：这台 mock NAS 的 PROPFIND 列目录与我们的用法对不上（列不到文件），
 *    所以体积直接按**落盘文件**核对 —— 验的是"写出去的东西长什么样"，本来就该看盘。
 *
 * 用法：
 *   node scripts/sync-two-peers.mjs                                    # 打本地 mock NAS（默认 15197）
 *   SYNC_URL=http://127.0.0.1:15199/ SYNC_DISK=.webdav-matrix/normal node scripts/sync-two-peers.mjs
 *
 * 对**真实** NAS / 网盘（Nextcloud、坚果云、MinIO 的 WebDAV 端点等）：远端不在本机，本地没有盘可读，
 * 于是加 `SYNC_NO_DISK=1` 跳过体积与落盘统计；其余断言（消息一致、断链回退、能力探测）照旧成立：
 *
 *   SYNC_URL=https://nas.example.com/storylantern/ WEBDAV_USER=... WEBDAV_PASSWORD=... SYNC_NO_DISK=1 \
 *     node scripts/sync-two-peers.mjs
 *
 * 本环境里没有第三方 NAS 可连（也不该在测试里依赖别人的账号），所以真实 NAS 这一条一直是"配方可复跑、
 * 但没有跑过"——这一点在文档里如实记着。
 */

const BASE_TIME = 1_700_000_000_000;

/** 从落盘目录里列出某前缀下的文件（体积也一并取到）。 */
export function diskFiles(root, prefix) {
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
  walk(root, '');
  return out;
}

/**
 * 跑一遍两对端同步。`label` 只用于打印；返回的结构给矩阵脚本做断言。
 */
export async function runTwoPeers(input) {
  const url = input.url ?? 'http://127.0.0.1:15197/';
  const diskRoot = input.diskRoot ?? '.webdav-out';
  const label = input.label ?? '';
  const prefix = label === '' ? '' : `[${label}] `;
  /**
   * 远端不在本机（真实 NAS / 网盘）时，没有本地盘可读：体积与落盘统计要通过**后端自己**去问
   * （`input.remoteFiles`）；两者都没有就跳过统计。其余断言（消息一致、断链回退、能力探测）
   * **照旧** —— 它们只依赖协议与后端。
   */
  const noDisk = input.noDisk ?? process.env.SYNC_NO_DISK === '1';
  const files = async (target) =>
    input.remoteFiles !== undefined ? await input.remoteFiles(target) : noDisk ? [] : diskFiles(diskRoot, target);
  const hasSizes = input.remoteFiles !== undefined || !noDisk;

  const backend = input.backend ?? createWebDavBackend({ baseUrl: url });
  // 与产品同一条规则（apps/app/src/data/sync/app-sync.ts）：后端没有 `probe` 就用它**声明**的能力。
  // 文件夹后端就是这种形状 —— 它的能力是保守声明（没有条件写、没有范围读），不假装探测过。
  const probe = backend.probe;
  const capabilities =
    typeof probe === 'function' ? await probe.call(backend) : { ...backend.capabilities, probed: false };

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
  const afterFull = await files('snapshots/');
  console.log(
    `  ${prefix}发布方同步 3 次：远端快照 ${afterFull.length} 份` +
      (hasSizes ? `，体积 ${afterFull.map((f) => f.size ?? f.bytes ?? 0).join(' / ')} B` : '（远端不在本机，体积跳过）'),
  );

  for (const index of [3, 4]) {
    emit(a, index);
    await a.engine.sync(a.materializer);
  }
  const afterDeltas = await files('snapshots/');
  const sizes = afterDeltas.map((file) => file.size ?? file.bytes ?? 0).sort((left, right) => left - right);
  const smallest = sizes[0] ?? 0;
  const largest = sizes[sizes.length - 1] ?? 1;
  console.log(
    `  ${prefix}再改 2 条：远端快照 ${afterDeltas.length} 份` +
      (hasSizes ? `，体积（小→大）${sizes.join(' / ')} B；最小/最大 = ${(smallest / largest).toFixed(3)}` : ''),
  );

  const b = makePeer('peer-b');
  const resultB = await b.engine.sync(b.materializer);
  const converged = JSON.stringify(ids(b)) === JSON.stringify(ids(a));
  console.log(
    `  ${prefix}第二个对端同步：hydratedSessions=${resultB.hydratedSessions}` +
      `${resultB.snapshotChainLength === undefined ? '' : `、链上取 ${resultB.snapshotChainLength} 份`}` +
      `、下载 ${resultB.downloaded.length} 个文件、消息${converged ? '一致' : '**不一致**'}（${ids(b).join(',')}）`,
  );

  // 断链回退：删掉基准那一条（它不在本次下载列表里就说明链只有一份整份）
  const chainPaths = resultB.downloaded.filter((path) => path.startsWith('snapshots/'));
  const basePath = chainPaths[chainPaths.length - 1];
  let brokenChain = { ok: true, warnings: 0 };
  if (basePath !== undefined && capabilities.delete) {
    await backend.delete(basePath);
    const c = makePeer('peer-c');
    const resultC = await c.engine.sync(c.materializer);
    const sameC = JSON.stringify(ids(c)) === JSON.stringify(ids(a));
    const warned = resultC.warnings.some((warning) => warning.includes('快照不可用'));
    brokenChain = { ok: sameC && warned, warnings: resultC.warnings.length };
    console.log(
      `  ${prefix}断链后的新对端：hydratedSessions=${resultC.hydratedSessions}、消息${sameC ? '仍一致' : '**不一致**'}` +
        `（${ids(c).join(',')}）、告警 ${resultC.warnings.length} 条（${warned ? '含"快照不可用"' : '**没有"快照不可用"**'}）`,
    );
  } else {
    console.log(`  ${prefix}跳过断链回退（该后端没有删除能力或没有基准可删）`);
  }

  console.log(
    `  ${prefix}能力探测：条件写=${capabilities.conditionalPut}、范围读=${capabilities.rangeRead}、` +
      `删除=${capabilities.delete}、分页=${capabilities.listPagination}`,
  );
  if (noDisk && !hasSizes) {
    console.log(`  ${prefix}落盘统计跳过（远端不在本机）`);
  } else {
    const snapshots = await files('snapshots/');
    const segments = await files('logs/');
    console.log(`  ${prefix}最终落盘：快照 ${snapshots.length} 份、段 ${segments.length} 个`);
  }

  return {
    label,
    capabilities,
    converged,
    brokenChain,
    snapshotCount: afterDeltas.length,
    snapshotSizes: sizes,
    messageIds: ids(a),
  };
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && process.argv[1].replace(/\\/g, '/').endsWith('scripts/sync-two-peers.mjs');

if (invokedDirectly) {
  runTwoPeers({
    url: process.env.SYNC_URL ?? 'http://127.0.0.1:15197/',
    diskRoot: process.env.SYNC_DISK ?? '.webdav-out',
  })    .then((result) => {
      if (!result.converged) throw new Error('第二个对端的消息与发布方不一致');
      if (!result.brokenChain.ok) throw new Error('断链回退没有按预期工作');
      console.log('  [两对端] 结论：真 HTTP 后端上，整份 + 增量链可写、可读、断链可回退。');
    })
    .catch((error) => {
      console.error('  [两对端] 失败：' + (error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });
}
