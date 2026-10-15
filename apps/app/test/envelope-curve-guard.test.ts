import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebCryptoKeyWrap } from '../src/data/sync/envelope.ts';

/**
 * 真机没有 X25519 时的表现。
 *
 * 背景：真机（Chrome/WebView）的 WebCrypto **不认识 X25519**。当名单里还有**旧 X25519 对端**时，
 * 旧代码会直接抛 `Failed to execute 'generateKey' on 'SubtleCrypto': Algorithm: Unrecognized name`
 * —— 用户看不懂，我们也没得到"该怎么做"的信息。
 *
 * 现在先探测曲线是否可用，再用人话拒绝：说明是哪条曲线、是给谁包、以及该找谁做这一步。
 * （能服务旧对端的设备照样能做——比如更新 WebView 的那台模拟器。）
 */

test('真机没有 X25519 时，给旧对端包钥匙必须给人话错误（不是 Unrecognized name）', async () => {
  // 32 字节 = 旧 X25519 曲线；这里只需要长度，用来触发"按长度选曲线"
  const legacyPublicKey = '11'.repeat(32);

  const subtle = globalThis.crypto.subtle as unknown as {
    generateKey: (...args: unknown[]) => Promise<unknown>;
  };
  const realGenerateKey = subtle.generateKey.bind(subtle);
  subtle.generateKey = async (algorithm: unknown, ...rest: unknown[]) => {
    if ((algorithm as { name?: string }).name === 'X25519') {
      throw new Error(
        "Failed to execute 'generateKey' on 'SubtleCrypto': Algorithm: Unrecognized name",
      );
    }
    return realGenerateKey(algorithm, ...rest);
  };

  try {
    const port = createWebCryptoKeyWrap();
    await assert.rejects(
      () => port.wrapFor(legacyPublicKey, new Uint8Array(32)),
      /不认识 X25519/,
      '应当给出"这台设备不认识 X25519"的人话说明',
    );
  } finally {
    subtle.generateKey = realGenerateKey;
  }
});

test('同一台设备给 P-256 对端包装照常可用（真机的正常路径不受影响）', async () => {
  const port = createWebCryptoKeyWrap();
  const keys = await port.generateAgreementKeys();
  const contentKey = await port.randomContentKey();
  const wrapped = await port.wrapFor(keys.publicKey, contentKey);
  const opened = await port.unwrapWith(keys.privateKey, keys.publicKey, wrapped);
  assert.deepEqual([...opened], [...contentKey]);
});
