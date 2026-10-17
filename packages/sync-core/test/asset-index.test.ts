import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetIndexAad,
  assetIndexPath,
  assetIndexSignaturePayload,
  decodeAssetIndex,
  encodeAssetIndex,
  isSafeAssetIndexDeviceId,
  parseAssetIndexPath,
  validateAssetIndex,
  type AssetIndex,
} from '../src/asset-index.ts';
import { encodeEnvelope } from '../src/envelope.ts';
import { createAesGcmCipher, nodeDigest, nodeGzip } from '../../oplog/src/node-adapters.ts';
import type { CryptoPorts, SegmentSigner, SignatureVerifier } from '../../oplog/src/ports.ts';

const INDEX: AssetIndex = {
  v: 1,
  deviceId: 'device-a',
  updatedAt: 1_700_000_000_000,
  entries: [
    { plain: 'a'.repeat(64), cipher: 'b'.repeat(64), bytes: 123 },
    { plain: 'c'.repeat(64), cipher: 'd'.repeat(64), bytes: 456 },
  ],
};

function ports(options: { cipher?: boolean; signer?: SegmentSigner; verifier?: SignatureVerifier } = {}): CryptoPorts {
  const base: CryptoPorts = { digest: nodeDigest, compressor: nodeGzip };
  return {
    ...base,
    ...(options.cipher === true ? { cipher: createAesGcmCipher({ key: new Uint8Array(32).fill(7) }) } : {}),
    ...(options.signer === undefined ? {} : { signer: options.signer }),
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** 极简签名端口：签名 = sha256(数据)，验签 = 比对摘要（够验证"签名覆盖了哪些字段"）。 */
function fakeSigning(deviceId: string): { signer: SegmentSigner; verifier: SignatureVerifier } {
  const signer: SegmentSigner = { deviceId, sign: (data) => nodeDigest.sha256(data) };
  const verifier: SignatureVerifier = {
    async verify(id, data, signature) {
      if (id !== deviceId) return false;
      const expected = await nodeDigest.sha256(data);
      return bytesEqual(expected, signature);
    },
  };
  return { signer, verifier };
}

test('索引：加密 + 签名往返，路径按 seq/hash8 命名', async () => {
  const { signer, verifier } = fakeSigning('device-a');
  const signed = ports({ cipher: true, signer, verifier });
  const encoded = await encodeAssetIndex(INDEX, { ports: signed, seq: 3, encrypt: true });

  assert.match(encoded.path, /^assets\/index\/device-a-00000003-[0-9a-f]{8}\.json\.gz$/);
  assert.equal(encoded.path, assetIndexPath('device-a', 3, encoded.hash));

  const decoded = await decodeAssetIndex(encoded.bytes, {
    ports: signed,
    deviceId: 'device-a',
    seq: 3,
    requireSignature: true,
  });
  assert.deepEqual(decoded.index, INDEX);
  assert.match(decoded.contentHash, /^[0-9a-f]{64}$/);
});

test('索引：设备不匹配必须拒绝（AAD 绑定设备）', async () => {
  const cipher = ports({ cipher: true });
  const encoded = await encodeAssetIndex(INDEX, { ports: cipher, seq: 1, encrypt: true });
  await assert.rejects(
    () => decodeAssetIndex(encoded.bytes, { ports: cipher, deviceId: 'device-b', seq: 1 }),
    /解密失败|信封/,
    'AAD 绑定 asset-index|device-a：换设备解密必然失败',
  );

  // 未加密时 AAD 不参与认证，但仍要按内容里的 deviceId 拒绝
  const plain = ports();
  const plainEncoded = await encodeAssetIndex(INDEX, { ports: plain, seq: 1 });
  await assert.rejects(
    () => decodeAssetIndex(plainEncoded.bytes, { ports: plain, deviceId: 'device-b', seq: 1 }),
    /归属设备/,
  );
});

test('索引：畸形（坏 JSON / 版本 / 哈希 / bytes）一律拒绝', async () => {
  const plain = ports();
  const badJson = await encodeEnvelope('{这不是 JSON', { ports: plain, aad: assetIndexAad('device-a') });
  await assert.rejects(() => decodeAssetIndex(badJson, { ports: plain, deviceId: 'device-a', seq: 1 }), /不是合法 JSON/);

  const wrongVersion = JSON.stringify({ ...INDEX, v: 2 });
  const bytes = await encodeEnvelope(wrongVersion, { ports: plain, aad: assetIndexAad('device-a') });
  await assert.rejects(() => decodeAssetIndex(bytes, { ports: plain, deviceId: 'device-a', seq: 1 }), /版本/);

  for (const entry of [
    { plain: 'not-hex', cipher: 'b'.repeat(64), bytes: 1 },
    { plain: 'a'.repeat(64), cipher: '../../escape', bytes: 1 },
    { plain: 'a'.repeat(64), cipher: 'b'.repeat(64), bytes: -1 },
  ]) {
    const inner = JSON.stringify({ ...INDEX, entries: [entry] });
    const tampered = await encodeEnvelope(inner, { ports: plain, aad: assetIndexAad('device-a') });
    await assert.rejects(() => decodeAssetIndex(tampered, { ports: plain, deviceId: 'device-a', seq: 1 }));
  }
});

test('索引签名：sign 收到的 payload 是规范元组，验签失败则拒绝', async () => {
  const signedPayloads: string[] = [];
  const verifiedPayloads: string[] = [];
  const signer: SegmentSigner = {
    deviceId: 'device-a',
    async sign(data) {
      signedPayloads.push(new TextDecoder().decode(data));
      return nodeDigest.sha256(data);
    },
  };
  const verifier: SignatureVerifier = {
    async verify(deviceId, data, signature) {
      if (deviceId !== 'device-a') return false;
      verifiedPayloads.push(new TextDecoder().decode(data));
      return bytesEqual(await nodeDigest.sha256(data), signature);
    },
  };
  const encoded = await encodeAssetIndex(INDEX, { ports: ports({ cipher: true, signer }), seq: 5, encrypt: true });
  const decoded = await decodeAssetIndex(encoded.bytes, {
    ports: ports({ cipher: true, verifier }),
    deviceId: 'device-a',
    seq: 5,
    requireSignature: true,
  });
  const expectedPayload = assetIndexSignaturePayload('device-a', 5, decoded.contentHash);
  assert.deepEqual(signedPayloads, [expectedPayload], '签名覆盖：用途|设备|seq|内容摘要');
  assert.deepEqual(verifiedPayloads, [expectedPayload], '验签用同一条规范元组');

  // 验签失败：一律拒绝（不采信索引条目）
  const alwaysFalse: SignatureVerifier = { async verify() { return false; } };
  await assert.rejects(
    () =>
      decodeAssetIndex(encoded.bytes, {
        ports: ports({ cipher: true, verifier: alwaysFalse }),
        deviceId: 'device-a',
        seq: 5,
        requireSignature: true,
      }),
    /签名无效/,
  );
});

test('索引：无签名可以读（容忍），但要求签名时必须拒绝', async () => {
  const plain = ports();
  const unsigned = await encodeAssetIndex(INDEX, { ports: plain, seq: 2 });
  // 默认容忍
  const decoded = await decodeAssetIndex(unsigned.bytes, { ports: plain, deviceId: 'device-a', seq: 2 });
  assert.deepEqual(decoded.index, INDEX);

  const { verifier } = fakeSigning('device-a');
  await assert.rejects(
    () => decodeAssetIndex(unsigned.bytes, { ports: ports({ verifier }), deviceId: 'device-a', seq: 2, requireSignature: true }),
    /缺少签名/,
  );
});

test('索引：旧格式（v1 信封）仍可读；签名/摘要不匹配拒绝', async () => {
  const plain = ports();
  const inner = JSON.stringify(INDEX);
  const legacy = await encodeEnvelope(inner, { ports: plain, aad: assetIndexAad('device-a'), format: 1 });
  const decoded = await decodeAssetIndex(legacy, { ports: plain, deviceId: 'device-a', seq: 1 });
  assert.deepEqual(decoded.index, INDEX);

  // 签名覆盖 seq：用 seq=9 的签名去验 seq=1 必须失败
  const { signer, verifier } = fakeSigning('device-a');
  const signed = ports({ signer });
  const encoded = await encodeAssetIndex(INDEX, { ports: signed, seq: 9 });
  await assert.rejects(
    () => decodeAssetIndex(encoded.bytes, { ports: ports({ verifier }), deviceId: 'device-a', seq: 1, requireSignature: true }),
    /签名无效/,
  );
  // 正确 seq 则通过
  await decodeAssetIndex(encoded.bytes, { ports: ports({ verifier }), deviceId: 'device-a', seq: 9, requireSignature: true });
});

test('路径：命名/反解往返，非索引路径与非法设备 id 被拒', () => {
  const path = assetIndexPath('device-a', 7, 'f'.repeat(64));
  assert.equal(path, 'assets/index/device-a-00000007-ffffffff.json.gz');
  assert.deepEqual(parseAssetIndexPath(path), { deviceId: 'device-a', seq: 7, hash8: 'ffffffff' });
  assert.equal(parseAssetIndexPath('devices/device-a-00000007-ffffffff.json.gz'), undefined);
  assert.equal(parseAssetIndexPath('assets/index/device-a-7-ffffffff.json.gz'), undefined);
  assert.equal(isSafeAssetIndexDeviceId('device-a'), true);
  assert.equal(isSafeAssetIndexDeviceId('../evil'), false);
  assert.equal(isSafeAssetIndexDeviceId(''), false);

  // 直接校验也能挡住路径穿越式的 hash
  assert.throws(() => validateAssetIndex({ ...INDEX, entries: [{ plain: 'a'.repeat(64), cipher: '..', bytes: 1 }] }));
  assert.equal(assetIndexAad('device-a'), 'asset-index|device-a');
  assert.equal(assetIndexSignaturePayload('device-a', 3, 'deadbeef'), 'asset-index|device-a|3|deadbeef');
});
