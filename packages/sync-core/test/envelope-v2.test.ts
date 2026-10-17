import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEnvelope, encodeEnvelope } from '../src/envelope.ts';
import { decodeManifest, encodeManifest, type Manifest } from '../src/manifest.ts';
import { createAesGcmCipher, nodeDigest, nodeGzip } from '../../oplog/src/node-adapters.ts';

/**
 * 信封 v2（B′）：manifest、snapshot、资产索引共用的"压缩 + 可选加密"。
 *
 * 换的理由（实测，见 scripts/measure-envelope.mjs 与 DEVELOPMENT.md 二·补13）：v1 是
 * **先 seal 加密 → 密文 base64 塞进 JSON → 最后才 gzip 整个 JSON**，gzip 面对 base64 文本几乎压不动。
 * 6.6MB 的快照体：v1 输出 6,645,232 B、耗时 639ms；v2（先 gzip → 再 seal → 二进制拼帧）
 * 输出 660,989 B、51ms —— **10× 更小、12.5× 更快**。
 *
 * 签名已整体删除；本文件钉住：v2 往返与压缩比、**v1 老文件仍读得出来**（含消费方层面）、
 * AAD 语义、篡改能被抓、旧文件里残留的签名字段被忽略。
 */

const key = new Uint8Array(32).fill(5);
const ports = {
  digest: nodeDigest,
  compressor: nodeGzip,
  cipher: createAesGcmCipher({ key }),
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

test('双读：消费方层面——新构建仍读得回老格式的 manifest（含已删除的 publicKey 字段）', async () => {
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
    const decoded = await decodeManifest(encoded.bytes, { ports, expectDeviceId: 'device-a' });
    assert.equal(decoded.seq, 7, `信封格式 ${format} 下 manifest 必须往返成功`);
    assert.equal(decoded.sessions['blind']?.lastSeq, 3);
  }

  // 旧清单里可能还写着 publicKey：解析时忽略，不能报错
  const legacyInner = JSON.stringify({ ...manifest, publicKey: 'b2xkLWtleQ==' });
  const legacyBytes = await encodeEnvelope(legacyInner, { ports, aad, format: 1 });
  const legacy = await decodeManifest(legacyBytes, { ports, expectDeviceId: 'device-a' });
  assert.equal(legacy.seq, 7);
});

test('兼容：旧 v2 头部残留 sig 字段被忽略，内容照常读出', async () => {
  const bytes = await encodeEnvelope(smallInner, { ports, encrypt: true, aad });
  const newline = bytes.indexOf(0x0a);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(0, newline))) as Record<string, unknown>;
  const legacy = new Uint8Array([
    ...new TextEncoder().encode(JSON.stringify({ ...header, sig: 'b2xkLXNpZ25hdHVyZQ==' })),
    0x0a,
    ...bytes.subarray(newline + 1),
  ]);
  const decoded = await decodeEnvelope(legacy, { ports, aad });
  assert.equal(decoded.inner, smallInner);
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
