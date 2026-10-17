import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Materializer, toHex, type CryptoPorts } from '../../../packages/oplog/src/index.ts';
import type { CharacterCard } from '../../../packages/cards/src/index.ts';
import { nodeDigest, nodeGzip } from '../../../packages/oplog/src/node-adapters.ts';
import { createAssetStore } from '../../../packages/sync-core/src/asset.ts';
import {
  ASSET_INDEX_PREFIX,
  assetIndexPath,
  decodeAssetIndex,
  parseAssetIndexPath,
} from '../../../packages/sync-core/src/asset-index.ts';
import type { SignerPort } from '../../../packages/sync-core/src/signing.ts';
import { createMemoryBackend, type MemoryBackend } from '../../../plugins/sync-memory/src/index.ts';
import type { AssetClient } from '../src/data/asset-client.ts';
import type { DeviceStore } from '../src/data/op-ports.ts';
import {
  collectAssetHashes,
  createAssetIndexSigningPorts,
  syncAssets,
  SYNC_ASSET_INDEX_SEQ_KEY,
  type AssetSyncSummary,
} from '../src/data/sync/assets-sync.ts';

/**
 * 资产同步的端到端契约（内存后端 + memory 资产库）。
 *
 * 钉住的是**跨设备可发现性**：明文 sha 在卡片里、密文哈希在远端，
 * 只有显式发布的索引能把两者连起来；同时钉住懒加载、篡改拒绝与索引保留策略。
 */

const PORTS: CryptoPorts = { digest: nodeDigest, compressor: nodeGzip };
const NOW = 1_700_000_000_000;

const PNG_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 20, 21, 22, 23, 24, 25]);
const PNG_C = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 40, 41, 42, 43]);

const hashOf = async (bytes: Uint8Array): Promise<string> => toHex(await nodeDigest.sha256(bytes));

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((byte, index) => byte === b[index]); }

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

/** 假"强模式"签名：签名 = sha256(设备私钥 ‖ 待签字节)；公钥为空（名单里没有该设备）→ 拒绝。 */
function signingPorts(deviceId: string, keys: Map<string, Uint8Array>): CryptoPorts {
  const owned = keys.get(deviceId);
  const signer: SignerPort = {
    algorithm: 'ed25519',
    deviceId,
    publicKeyHex: owned === undefined ? '' : toHex(owned),
    async sign(message) {
      if (owned === undefined) throw new Error(`没有 ${deviceId} 的私钥`);
      return nodeDigest.sha256(concatBytes(owned, message));
    },
    async verify(publicKeyHex, message, signature) {
      if (publicKeyHex === '') return false;
      return bytesEqual(await nodeDigest.sha256(concatBytes(hexToBytes(publicKeyHex), message)), signature);
    },
  };
  return createAssetIndexSigningPorts(PORTS, signer, (id) => {
    const key = keys.get(id);
    return key === undefined ? undefined : toHex(key);
  });
}

const STRONG_KEYS = new Map<string, Uint8Array>([['dev-a', new Uint8Array([1, 2, 3, 4])], ['dev-b', new Uint8Array([5, 6, 7, 8])]]);

interface MemoryAssets extends AssetClient {
  readonly data: Map<string, Uint8Array>;
}

async function memoryAssets(seed: readonly Uint8Array[] = []): Promise<MemoryAssets> {
  const data = new Map<string, Uint8Array>();
  const client: AssetClient = {
    kind: 'memory',
    available: true,
    persistent: false,
    async put(bytes) {
      const hash = await hashOf(bytes);
      if (!data.has(hash)) data.set(hash, Uint8Array.from(bytes));
      return hash;
    },
    async get(hash) {
      return data.get(hash);
    },
    async list() {
      return [...data.keys()].sort();
    },
    async remove(hash) {
      return data.delete(hash);
    },
  };
  for (const bytes of seed) await client.put(bytes);
  return Object.assign(client, { data });
}

interface MemoryDevice extends DeviceStore {
  readonly data: Map<string, string>;
}

function memoryDevice(): MemoryDevice {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

function characterCard(id: string, options: { cover?: string; visuals?: string[] } = {}): CharacterCard {
  return {
    card_type: 'character',
    meta: {
      id,
      schema: 'rolecard/v1',
      name: id,
      version: '1.0.0',
      language: 'zh-CN',
      rating: 'general',
      description: '资产同步测试',
      ...(options.cover === undefined ? {} : { cover: `asset://${options.cover}` }),
    },
    identity: { name: id, background: '' },
    persona: { summary: '', traits: ['测试'], knowledge_boundary: '', ability_boundary: '' },
    speech: { style: '' },
    ...(options.visuals === undefined || options.visuals.length === 0
      ? {}
      : {
          visuals: options.visuals.map((hash, index) => ({
            id: `${id}-v${index}`,
            type: 'portrait',
            path: `asset://${hash}`,
            caption: '测试图',
          })),
        }),
  };
}

function materializerWith(cards: readonly CharacterCard[]): Materializer {
  const materializer = new Materializer();
  for (const card of cards) {
    materializer.state.cards[card.meta.id] = {
      id: card.meta.id,
      card,
      createdHlc: { t: 1, c: 0 },
      updatedHlc: { t: 1, c: 0 },
      opId: `op-${card.meta.id}`,
    };
  }
  return materializer;
}

async function sync(
  backend: MemoryBackend,
  deviceId: string,
  device: DeviceStore,
  client: AssetClient,
  materializer: Materializer,
  signing?: CryptoPorts,
): Promise<AssetSyncSummary> {
  return syncAssets({
    backend,
    ports: PORTS,
    device,
    deviceId,
    materializer,
    assetClient: client,
    ...(signing === undefined ? {} : { signing }),
    now: () => NOW,
  });
}

function indexPaths(backend: MemoryBackend): string[] {
  return [...backend.files.keys()].filter((path) => path.startsWith(ASSET_INDEX_PREFIX)).sort();
}

function assetPaths(backend: MemoryBackend): string[] {
  return [...backend.files.keys()].filter((path) => path.startsWith('assets/') && !path.startsWith(ASSET_INDEX_PREFIX)).sort();
}

/** 改坏 A 的索引签名，并按新字节重算 hash8 重命名（否则会在 hash8 校验那步先被挡掉）。 */
async function forgeAssetIndexSignature(backend: MemoryBackend): Promise<void> {
  const path = indexPaths(backend)[0];
  assert.ok(path !== undefined);
  const bytes = await backend.get(path);
  const newline = bytes.indexOf(0x0a);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline))) as Record<string, unknown>;
  header['sig'] = Buffer.from([9, 9, 9]).toString('base64');
  const forged = concatBytes(new TextEncoder().encode(JSON.stringify(header)), bytes.subarray(newline));
  backend.remove(path);
  backend.seed(assetIndexPath('dev-a', 1, await hashOf(forged)), forged);
}

test('请求集：visuals[].path 与 meta.cover 都扫，非 asset 引用忽略，未知卡片类型不崩', () => {
  const materializer = materializerWith([
    characterCard('c1', { cover: 'a'.repeat(64), visuals: ['b'.repeat(64), 'a'.repeat(64)] }),
    characterCard('c2', { visuals: ['c'.repeat(64)] }),
  ]);
  // 没被引用的卡片/路径不进请求集
  materializer.state.cards['x'] = {
    id: 'x',
    card: { ...characterCard('x'), meta: { ...characterCard('x').meta, cover: '/abs/path.png' } },
    createdHlc: { t: 1, c: 0 },
    updatedHlc: { t: 1, c: 0 },
    opId: 'op-x',
  };
  assert.deepEqual(collectAssetHashes(materializer.state), ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)]);
});

test('两设备：A 上传 + 发布索引，B 拉 op 后按索引下载并通过 sha 校验', async () => {
  const backend = createMemoryBackend();
  const plain = await hashOf(PNG_A);
  const aClient = await memoryAssets([PNG_A]);
  const aDevice = memoryDevice();
  const a = await sync(backend, 'dev-a', aDevice, aClient, materializerWith([characterCard('c1', { cover: plain })]));
  assert.equal(a.uploaded, 1);
  assert.equal(a.downloaded, 0);
  assert.ok(a.warnings.some((warning) => warning.includes('内存')), '浏览器内存资产库要如实警告');

  const paths = indexPaths(backend);
  assert.equal(paths.length, 1);
  const parsed = parseAssetIndexPath(paths[0] as string);
  assert.equal(parsed?.deviceId, 'dev-a');
  assert.equal(parsed?.seq, 1);
  const decoded = await decodeAssetIndex(await backend.get(paths[0] as string), {
    ports: PORTS,
    deviceId: 'dev-a',
    seq: 1,
  });
  const entry = decoded.index.entries[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.plain, plain);
  const remote = await createAssetStore({ backend, ports: PORTS }).get(entry.cipher);
  assert.deepEqual([...remote], [...PNG_A], '远端存的是卡片引用对应的那张图');

  const bClient = await memoryAssets();
  const bDevice = memoryDevice();
  const b = await sync(backend, 'dev-b', bDevice, bClient, materializerWith([characterCard('c1', { cover: plain })]));
  assert.equal(b.downloaded, 1);
  assert.deepEqual([...(await bClient.get(plain)) ?? []], [...PNG_A], '落库的字节必须与明文 sha 对上');
  assert.equal((await bClient.list()).length, 1);
});

test('B 本地已有同 sha：不重复下载（但仍会建立自己的索引）', async () => {
  const backend = createMemoryBackend();
  const plain = await hashOf(PNG_A);
  const aClient = await memoryAssets([PNG_A]);
  await sync(backend, 'dev-a', memoryDevice(), aClient, materializerWith([characterCard('c1', { cover: plain })]));

  const bClient = await memoryAssets([PNG_A]);
  const b = await sync(backend, 'dev-b', memoryDevice(), bClient, materializerWith([characterCard('c1', { cover: plain })]));
  assert.equal(b.downloaded, 0, '本地已有同 sha 就不再拉一遍');
  assert.equal((await bClient.list()).length, 1);
  assert.equal(indexPaths(backend).filter((path) => path.includes('dev-b')).length, 1, 'B 也会发布自己的索引（远端密文不同）');
});

test('远端资产被篡改：sha 校验失败、告警、不落库', async () => {
  const backend = createMemoryBackend();
  const plain = await hashOf(PNG_A);
  const aClient = await memoryAssets([PNG_A]);
  await sync(backend, 'dev-a', memoryDevice(), aClient, materializerWith([characterCard('c1', { cover: plain })]));

  const target = assetPaths(backend)[0];
  assert.ok(target !== undefined);
  const tampered = Uint8Array.from(await backend.get(target));
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
  backend.seed(target, tampered);

  const bClient = await memoryAssets();
  const b = await sync(backend, 'dev-b', memoryDevice(), bClient, materializerWith([characterCard('c1', { cover: plain })]));
  assert.equal(b.downloaded, 0);
  assert.ok(b.warnings.some((warning) => warning.includes('校验失败')), '篡改必须告警');
  assert.equal(await bClient.get(plain), undefined, '校验不过的内容绝不落库');
});

test('懒加载：只下载卡片引用的资产，索引里其它资产不下', async () => {
  const backend = createMemoryBackend();
  const plainA = await hashOf(PNG_A);
  const plainB = await hashOf(PNG_B);
  const aClient = await memoryAssets([PNG_A, PNG_B]);
  const a = await sync(backend, 'dev-a', memoryDevice(), aClient, materializerWith([characterCard('c1', { visuals: [plainA] })]));
  assert.equal(a.uploaded, 2, '本机资产都上传');
  assert.equal(assetPaths(backend).length, 2);

  const bClient = await memoryAssets();
  const b = await sync(backend, 'dev-b', memoryDevice(), bClient, materializerWith([characterCard('c1', { visuals: [plainA] })]));
  assert.equal(b.downloaded, 1, '只下载被引用的那张');
  assert.deepEqual([...(await bClient.get(plainA)) ?? []], [...PNG_A]);
  assert.equal(await bClient.get(plainB), undefined, '没被引用的图不下载（懒加载）');
});

test('索引：seq 单调递增、只保留最近 2 份，映射持久化到设备 kv', async () => {
  const backend = createMemoryBackend();
  const device = memoryDevice();
  const client = await memoryAssets([PNG_A]);
  const materializer = materializerWith([characterCard('c1', { visuals: [await hashOf(PNG_A)] })]);

  const first = await sync(backend, 'dev-a', device, client, materializer);
  assert.equal(first.indexSeq, 1);
  await client.put(PNG_B);
  const second = await sync(backend, 'dev-a', device, client, materializer);
  assert.equal(second.indexSeq, 2);
  await client.put(PNG_C);
  const third = await sync(backend, 'dev-a', device, client, materializer);
  assert.equal(third.indexSeq, 3);

  const own = indexPaths(backend)
    .map((path) => parseAssetIndexPath(path))
    .filter((parsed) => parsed !== undefined && parsed.deviceId === 'dev-a')
    .map((parsed) => parsed?.seq as number)
    .sort((a, b) => a - b);
  assert.deepEqual(own, [2, 3], '只保留最近 2 份索引');
  assert.equal(device.data.get(SYNC_ASSET_INDEX_SEQ_KEY), '3');

  const map = JSON.parse(device.data.get('sync.asset-map.v1') ?? '{}') as Record<string, string>;
  assert.equal(map[await hashOf(PNG_A)]?.length, 64, '明文 sha → 远端密文的映射已持久化');
});

test('强模式：A 用设备密钥签索引，B 用名单公钥验证并下载', async () => {
  const backend = createMemoryBackend();
  const plain = await hashOf(PNG_A);
  const aClient = await memoryAssets([PNG_A]);
  const a = await sync(backend, 'dev-a', memoryDevice(), aClient, materializerWith([characterCard('c1', { cover: plain })]), signingPorts('dev-a', STRONG_KEYS));
  assert.equal(a.uploaded, 1);

  // A 发布的索引必须带签名（用 A 的端口以 requireSignature=true 读回来）
  const path = indexPaths(backend)[0];
  assert.ok(path !== undefined);
  const signed = await decodeAssetIndex(await backend.get(path), {
    ports: signingPorts('dev-a', STRONG_KEYS),
    deviceId: 'dev-a',
    seq: 1,
    requireSignature: true,
  });
  assert.notEqual(signed.envelope.sig, undefined, '索引必须有 sig');

  const bClient = await memoryAssets();
  const b = await sync(backend, 'dev-b', memoryDevice(), bClient, materializerWith([characterCard('c1', { cover: plain })]), signingPorts('dev-b', STRONG_KEYS));
  assert.equal(b.downloaded, 1);
  assert.equal(b.warnings.some((warning) => warning.includes('读取失败')), false);
  assert.deepEqual([...(await bClient.get(plain)) ?? []], [...PNG_A]);
});

test('强模式：索引签名被篡改 → B 跳过索引并告警，不下载', async () => {
  const backend = createMemoryBackend();
  const plain = await hashOf(PNG_A);
  const aClient = await memoryAssets([PNG_A]);
  await sync(backend, 'dev-a', memoryDevice(), aClient, materializerWith([characterCard('c1', { cover: plain })]), signingPorts('dev-a', STRONG_KEYS));
  await forgeAssetIndexSignature(backend);

  const bClient = await memoryAssets();
  const b = await sync(backend, 'dev-b', memoryDevice(), bClient, materializerWith([characterCard('c1', { cover: plain })]), signingPorts('dev-b', STRONG_KEYS));
  assert.equal(b.downloaded, 0);
  assert.ok(b.warnings.some((warning) => warning.includes('签名无效')), `应告警验签失败：${b.warnings.join(' | ')}`);
  assert.equal(await bClient.get(plain), undefined, '验签不过的索引条目不采信');
});

test('强模式：名单里没有 A 的公钥 → 验签失败、索引被跳过', async () => {
  const backend = createMemoryBackend();
  const plain = await hashOf(PNG_A);
  const aClient = await memoryAssets([PNG_A]);
  await sync(backend, 'dev-a', memoryDevice(), aClient, materializerWith([characterCard('c1', { cover: plain })]), signingPorts('dev-a', STRONG_KEYS));

  const withoutA = new Map(STRONG_KEYS);
  withoutA.delete('dev-a');
  const bClient = await memoryAssets();
  const b = await sync(backend, 'dev-b', memoryDevice(), bClient, materializerWith([characterCard('c1', { cover: plain })]), signingPorts('dev-b', withoutA));
  assert.equal(b.downloaded, 0);
  assert.ok(b.warnings.some((warning) => warning.includes('签名无效')));
  assert.equal(await bClient.get(plain), undefined);
});

test('兼容：旧索引无签名仍可读（告警一次），不因升级而失联', async () => {
  const backend = createMemoryBackend();
  const plain = await hashOf(PNG_A);
  const aClient = await memoryAssets([PNG_A]);
  // A 用旧行为（不传 signing）发布索引：无签名
  await sync(backend, 'dev-a', memoryDevice(), aClient, materializerWith([characterCard('c1', { cover: plain })]));

  const path = indexPaths(backend)[0];
  assert.ok(path !== undefined);
  const unsigned = await decodeAssetIndex(await backend.get(path), { ports: PORTS, deviceId: 'dev-a', seq: 1 });
  assert.equal(unsigned.envelope.sig, undefined, '旧索引确实没有签名');

  const bClient = await memoryAssets();
  const b = await sync(backend, 'dev-b', memoryDevice(), bClient, materializerWith([characterCard('c1', { cover: plain })]), signingPorts('dev-b', STRONG_KEYS));
  assert.equal(b.downloaded, 1, '无签名旧索引按兼容模式采信');
  assert.ok(b.warnings.some((warning) => warning.includes('没有签名')), '要明确告警"无签名"');
});
