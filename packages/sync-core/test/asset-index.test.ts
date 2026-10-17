import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetIndexAad,
  assetIndexPath,
  decodeAssetIndex,
  encodeAssetIndex,
  isSafeAssetIndexDeviceId,
  parseAssetIndexPath,
  validateAssetIndex,
  type AssetIndex,
} from '../src/asset-index.ts';
import { encodeEnvelope } from '../src/envelope.ts';
import { createAesGcmCipher, nodeDigest, nodeGzip } from '../../oplog/src/node-adapters.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';

const INDEX: AssetIndex = {
  v: 1,
  deviceId: 'device-a',
  updatedAt: 1_700_000_000_000,
  entries: [
    { plain: 'a'.repeat(64), cipher: 'b'.repeat(64), bytes: 123 },
    { plain: 'c'.repeat(64), cipher: 'd'.repeat(64), bytes: 456 },
  ],
};

function ports(options: { cipher?: boolean } = {}): CryptoPorts {
  return {
    digest: nodeDigest,
    compressor: nodeGzip,
    ...(options.cipher === true ? { cipher: createAesGcmCipher({ key: new Uint8Array(32).fill(7) }) } : {}),
  };
}

test('索引：加密往返，路径按 seq/hash8 命名', async () => {
  const cipher = ports({ cipher: true });
  const encoded = await encodeAssetIndex(INDEX, { ports: cipher, seq: 3, encrypt: true });

  assert.match(encoded.path, /^assets\/index\/device-a-00000003-[0-9a-f]{8}\.json\.gz$/);
  assert.equal(encoded.path, assetIndexPath('device-a', 3, encoded.hash));

  const decoded = await decodeAssetIndex(encoded.bytes, { ports: cipher, deviceId: 'device-a' });
  assert.deepEqual(decoded.index, INDEX);
  assert.match(decoded.contentHash, /^[0-9a-f]{64}$/);
});

test('索引：设备不匹配必须拒绝（AAD 绑定设备）', async () => {
  const cipher = ports({ cipher: true });
  const encoded = await encodeAssetIndex(INDEX, { ports: cipher, seq: 1, encrypt: true });
  await assert.rejects(
    () => decodeAssetIndex(encoded.bytes, { ports: cipher, deviceId: 'device-b' }),
    /解密失败|信封/,
    'AAD 绑定 asset-index|device-a：换设备解密必然失败',
  );

  // 未加密时 AAD 不参与认证，但仍要按内容里的 deviceId 拒绝
  const plain = ports();
  const plainEncoded = await encodeAssetIndex(INDEX, { ports: plain, seq: 1 });
  await assert.rejects(
    () => decodeAssetIndex(plainEncoded.bytes, { ports: plain, deviceId: 'device-b' }),
    /归属设备/,
  );
});

test('索引：畸形（坏 JSON / 版本 / 哈希 / bytes）一律拒绝', async () => {
  const plain = ports();
  const badJson = await encodeEnvelope('{这不是 JSON', { ports: plain, aad: assetIndexAad('device-a') });
  await assert.rejects(() => decodeAssetIndex(badJson, { ports: plain, deviceId: 'device-a' }), /不是合法 JSON/);

  const wrongVersion = JSON.stringify({ ...INDEX, v: 2 });
  const bytes = await encodeEnvelope(wrongVersion, { ports: plain, aad: assetIndexAad('device-a') });
  await assert.rejects(() => decodeAssetIndex(bytes, { ports: plain, deviceId: 'device-a' }), /版本/);

  for (const entry of [
    { plain: 'not-hex', cipher: 'b'.repeat(64), bytes: 1 },
    { plain: 'a'.repeat(64), cipher: '../../escape', bytes: 1 },
    { plain: 'a'.repeat(64), cipher: 'b'.repeat(64), bytes: -1 },
  ]) {
    const inner = JSON.stringify({ ...INDEX, entries: [entry] });
    const tampered = await encodeEnvelope(inner, { ports: plain, aad: assetIndexAad('device-a') });
    await assert.rejects(() => decodeAssetIndex(tampered, { ports: plain, deviceId: 'device-a' }));
  }
});

test('索引：旧格式（v1 信封）仍可读', async () => {
  const plain = ports();
  const legacy = await encodeEnvelope(JSON.stringify(INDEX), { ports: plain, aad: assetIndexAad('device-a'), format: 1 });
  const decoded = await decodeAssetIndex(legacy, { ports: plain, deviceId: 'device-a' });
  assert.deepEqual(decoded.index, INDEX);
});

test('兼容：旧索引内容里残留的签名字段被忽略，映射照常读出', async () => {
  const plain = ports();
  const legacyInner = JSON.stringify({ ...INDEX, sig: 'b2xkLXNpZ25hdHVyZQ==' });
  const bytes = await encodeEnvelope(legacyInner, { ports: plain, aad: assetIndexAad('device-a'), format: 1 });
  const decoded = await decodeAssetIndex(bytes, { ports: plain, deviceId: 'device-a' });
  assert.deepEqual(decoded.index, INDEX);
  assert.equal('sig' in decoded.index, false, '读取后的对象不再带签名字段');
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
});
