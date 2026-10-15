import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyring, openKeyring } from '../../../packages/sync-core/src/keyring.ts';
import { toHex } from '../../../packages/sync-core/src/signing.ts';
import {
  createWebCryptoKeyWrap,
  curveOfPublicKey,
  detectKeyWrapSupport,
} from '../src/data/sync/envelope.ts';

/**
 * 包钥匙的两条曲线共存。
 *
 * 背景（真机踩出来的）：最早用 X25519，但**真机 WebView（Chrome）没有 WebCrypto X25519**，
 * 于是真机根本加入不了共享目录。改成 **P-256** 之后：
 *  - 新记录一律 P-256（真机也支持）；
 *  - 但**旧记录**（X25519 包的）与**旧对端的公钥**（32 字节）必须继续能用，
 *    所以按公钥长度选曲线，解包时两种都试。
 *
 * 这组测试就盯这三件事：P-256 往返、给旧 X25519 对端包/解、混合 keyring 两边都能打开。
 */

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 手工造一对**旧版** X25519 密钥（模拟升级前生成、现在还在名单里的对端）。 */
async function legacyX25519Pair(): Promise<{ publicKey: string; privateKey: string }> {
  const subtle = globalThis.crypto.subtle;
  const pair = (await subtle.generateKey({ name: 'X25519' } as never, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  return { publicKey: toHex(raw), privateKey: toHex(pkcs8) };
}

test('曲线识别：P-256 公钥 65 字节、X25519 32 字节', async () => {
  const port = createWebCryptoKeyWrap();
  const mine = await port.generateAgreementKeys();
  assert.equal(mine.publicKey.length, 130, 'P-256 的 raw 公钥应当是同 130 个十六进制字符');
  assert.equal(curveOfPublicKey(mine.publicKey), 'P-256');
  const legacy = await legacyX25519Pair();
  assert.equal(legacy.publicKey.length, 64, 'X25519 的 raw 公钥是 64 个十六进制字符');
  assert.equal(curveOfPublicKey(legacy.publicKey), 'X25519');
});

test('P-256：包给自己再解开，内容钥匙一模一样', async () => {
  const port = createWebCryptoKeyWrap();
  assert.equal(await detectKeyWrapSupport(), true, 'P-256 在 Node 的 WebCrypto 里应当可用');
  const keys = await port.generateAgreementKeys();
  const contentKey = await port.randomContentKey();
  const wrapped = await port.wrapFor(keys.publicKey, contentKey);
  const opened = await port.unwrapWith(keys.privateKey, keys.publicKey, wrapped);
  assert.deepEqual([...opened], [...contentKey]);
});

test('给旧 X25519 对端仍能包，旧对端也解得开（升级不打断老设备）', async () => {
  const port = createWebCryptoKeyWrap();
  const legacy = await legacyX25519Pair();
  const contentKey = await port.randomContentKey();
  // 用**新代码**包给一把**旧曲线**的公钥
  const wrapped = await port.wrapFor(legacy.publicKey, contentKey);
  // 旧对端用自己的私钥解开（它会走 X25519 那条分支）
  const opened = await port.unwrapWith(legacy.privateKey, legacy.publicKey, wrapped);
  assert.deepEqual([...opened], [...contentKey]);
});

test('混合 keyring：一个 P-256 收件人 + 一个 X25519 收件人，两边都能打开同一把数据钥匙', async () => {
  const port = createWebCryptoKeyWrap();
  const fresh = await port.generateAgreementKeys(); // 新设备 → P-256
  const legacy = await legacyX25519Pair(); // 老设备 → X25519
  const created = await createKeyring(
    port,
    [
      { deviceId: 'fresh', publicKey: fresh.publicKey },
      { deviceId: 'legacy', publicKey: legacy.publicKey },
    ],
    1,
  );

  const forFresh = await openKeyring(port, created.keyring, 'fresh', fresh.privateKey, fresh.publicKey);
  const forLegacy = await openKeyring(port, created.keyring, 'legacy', legacy.privateKey, legacy.publicKey);
  assert.deepEqual([...forFresh], [...created.contentKey], '新的 P-256 设备能拿到数据钥匙');
  assert.deepEqual([...forLegacy], [...created.contentKey], '老的 X25519 设备也能拿到同一把数据钥匙');
});

test('别人解不开：换一对密钥来解必须失败', async () => {
  const port = createWebCryptoKeyWrap();
  const mine = await port.generateAgreementKeys();
  const other = await port.generateAgreementKeys();
  const contentKey = await port.randomContentKey();
  const wrapped = await port.wrapFor(mine.publicKey, contentKey);
  await assert.rejects(() => port.unwrapWith(other.privateKey, other.publicKey, wrapped));
});
