import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEnvelope, encodeEnvelope, verifyEnvelope } from '../src/envelope.ts';
import { decodeManifest, encodeManifest, type Manifest } from '../src/manifest.ts';
import {
  createAesGcmCipher,
  createDeviceSigner,
  createRosterVerifier,
  generateDeviceKeyPair,
  nodeDigest,
  nodeGzip,
} from '../../oplog/src/node-adapters.ts';

/**
 * 信封 v2（B′）：manifest 与 snapshot 共用的"压缩 + 可选加密 + 可选签名"。
 *
 * 换的理由（实测，见 scripts/measure-envelope.mjs 与 DEVELOPMENT.md 二·补13）：v1 是
 * **先 seal 加密 → 密文 base64 塞进 JSON → 最后才 gzip 整个 JSON**，gzip 面对 base64 文本几乎压不动。
 * 6.6MB 的快照体：v1 输出 6,645,232 B、耗时 639ms；v2（先 gzip → 再 seal → 二进制拼帧）
 * 输出 660,989 B、51ms —— **10× 更小、12.5× 更快**。
 *
 * 这个文件钉住四件事：v2 往返与压缩比达标、**v1 老文件仍读得出来**（迁移期双读，含消费方层面）、
 * AAD 与签名语义不变、篡改能被抓。
 */

const key = new Uint8Array(32).fill(5);
const signKeys = generateDeviceKeyPair('device-a');
const ports = {
  digest: nodeDigest,
  compressor: nodeGzip,
  cipher: createAesGcmCipher({ key }),
  signer: createDeviceSigner(signKeys),
};
const aad = 'manifest|device-a';

/** 一份"像 manifest 一样"的大载荷：可压缩、够大。 */
const bigInner = JSON.stringify({
  sessions: Array.from({ length: 400 }, (_, index) => ({
    id: `S${index}`,
    note: '风从北面灌进走廊，把灯芯压得只剩一线。',
  })),
});
const smallInner = JSON.stringify({ hello: '灯还亮着', n: 1 });

test('v2：加密与不加密都往返一致，且头部自报版本/加密算法', async () => {
  for (const encrypt of [true, false]) {
    const bytes = await encodeEnvelope(smallInner, { ports, encrypt, aad });
    const decoded = await decodeEnvelope(bytes, { ports, aad });
    assert.equal(decoded.inner, smallInner);
    assert.equal(decoded.envelope.v, 2, 'v2 的头部必须自报 v=2（读方据此与 v1 分叉）');
    // 算法名以适配器自报为准（Node 侧是 'aes-256-gcm'，app/设备侧那个实现报 'AES-GCM'）
    assert.equal(decoded.envelope.cipher, encrypt ? ports.cipher.algorithm : 'none');
    assert.equal(decoded.contentHash, decoded.contentHash.toLowerCase());
  }
});

test('v2：压缩比达到 PLAN 的 ≥3×（这就是换格式的理由）', async () => {
  const plainSize = new TextEncoder().encode(bigInner).length;
  const v2 = await encodeEnvelope(bigInner, { ports, encrypt: true, aad });
  const v1 = await encodeEnvelope(bigInner, { ports, encrypt: true, aad, format: 1 });
  const v2Ratio = plainSize / v2.length;
  const v1Ratio = plainSize / v1.length;
  console.log(
    `  [信封] 载荷 ${plainSize} B → v1 ${v1.length} B（${v1Ratio.toFixed(2)}×） / v2 ${v2.length} B（${v2Ratio.toFixed(2)}×）`,
  );
  assert.ok(v2Ratio >= 3, `v2 信封压缩比应当 ≥3×，实际 ${v2Ratio.toFixed(2)}×`);
  assert.ok(v2Ratio > v1Ratio * 2, 'v2 的压缩比应当明显优于 v1（否则这次改动没有意义）');
});

test('双读：v1 老信封仍能解开（含"密文是 base64"的老形状）', async () => {
  const bytes = await encodeEnvelope(smallInner, { ports, encrypt: true, aad, format: 1 });
  // 老形状自证：整段是 gzip，gunzip 出来是 JSON，密文在 ct 里、且是 base64
  const raw = await nodeGzip.decompress(bytes);
  const parsed = JSON.parse(new TextDecoder().decode(raw)) as { v: number; ct?: string };
  assert.equal(parsed.v, 1);
  assert.equal(typeof parsed.ct, 'string', 'v1 的密文应当是 base64 字符串（这正是被换掉的浪费）');
  assert.match(parsed.ct ?? '', /^[A-Za-z0-9+/]+=*$/);

  const decoded = await decodeEnvelope(bytes, { ports, aad });
  assert.equal(decoded.inner, smallInner, '老文件必须还能解开');
  assert.equal(decoded.envelope.v, 1);
});

test('双读：消费方层面——新构建仍读得回老格式的 manifest', async () => {
  const manifest: Manifest = {
    v: 1,
    deviceId: 'device-a',
    seq: 7,
    epoch: 1,
    updatedAt: 1_700_000_000_000,
    sessions: { blind: { blindSessionId: 'blind', lastSeq: 3, segments: { '1': 'aaaaaaaa' }, epoch: 1, bytes: 10 } },
    ack: {},
  };
  for (const format of [1, 2] as const) {
    const encoded = await encodeManifest(manifest, { ports, encrypt: true, format });
    const decoded = await decodeManifest(encoded.bytes, {
      ports: { ...ports, verifier: createRosterVerifier(new Map([['device-a', signKeys.publicKeyPem]])) },
      expectDeviceId: 'device-a',
    });
    assert.equal(decoded.seq, 7, `信封格式 ${format} 下 manifest 必须往返成功`);
    assert.equal(decoded.sessions['blind']?.lastSeq, 3);
  }
});

test('AAD 绑定：把信封从 manifest 挪到 snapshot（或换设备）就解不开', async () => {
  const bytes = await encodeEnvelope(smallInner, { ports, encrypt: true, aad });
  await assert.rejects(decodeEnvelope(bytes, { ports, aad: 'snapshot|blind-session' }), /解密失败|信封/);
  await assert.rejects(decodeEnvelope(bytes, { ports, aad: 'manifest|device-b' }), /解密失败|信封/);
  // 不加密时 AAD 不参与（v1 的既有语义，保持一致）
  const plain = await encodeEnvelope(smallInner, { ports, encrypt: false, aad });
  assert.equal((await decodeEnvelope(plain, { ports, aad: 'anything' })).inner, smallInner);
});

test('篡改会被抓：加密段改一个字节 → 解密失败；明文段改一个字节 → 解压/解析失败', async () => {
  const encrypted = await encodeEnvelope(bigInner, { ports, encrypt: true, aad });
  const tampered = new Uint8Array(encrypted);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
  await assert.rejects(decodeEnvelope(tampered, { ports, aad }), /解密失败/);

  const plain = await encodeEnvelope(bigInner, { ports, encrypt: false, aad });
  const plainTampered = new Uint8Array(plain);
  plainTampered[plainTampered.length - 1] = (plainTampered[plainTampered.length - 1] ?? 0) ^ 0xff;
  await assert.rejects(decodeEnvelope(plainTampered, { ports, aad }), /解压失败|解析失败/);
});

test('签名语义不变：sig 在明文头部、内容哈希照旧，payload 对不上就拒', async () => {
  const contentHashOf = async (inner: string) => {
    const digest = await nodeDigest.sha256(new TextEncoder().encode(inner));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  };
  const bytes = await encodeEnvelope(smallInner, {
    ports,
    encrypt: true,
    aad,
    sign: (contentHash) => `manifest|device-a|1|${contentHash}`,
  });
  const decoded = await decodeEnvelope(bytes, { ports, aad });
  assert.equal(typeof decoded.envelope.sig, 'string', '签名应当存在明文头部里（公开、被改只会让验签失败）');

  const verifier = createRosterVerifier(new Map([['device-a', signKeys.publicKeyPem]]));
  const goodPayload = `manifest|device-a|1|${await contentHashOf(smallInner)}`;
  assert.equal(goodPayload.includes(decoded.contentHash), true, 'contentHash 必须由解码方重新算出来（防替换）');

  await verifyEnvelope(decoded.envelope, {
    ports: { ...ports, verifier },
    contentHash: decoded.contentHash,
    payload: goodPayload,
    signerDeviceId: 'device-a',
  });
  await assert.rejects(
    verifyEnvelope(decoded.envelope, {
      ports: { ...ports, verifier },
      contentHash: decoded.contentHash,
      payload: goodPayload.replace('|1|', '|2|'),
      signerDeviceId: 'device-a',
    }),
    /签名无效/,
  );
});
