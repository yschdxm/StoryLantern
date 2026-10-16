import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebCryptoKeyWrap } from '../src/data/sync/envelope.ts';

/**
 * "这台设备做不了密钥协商"时的表现。
 *
 * 背景：真机 WebView 的能力差异很大（最早那批连换曲线的教训都在这里）。旧代码会在这种设备上直接抛
 * `Failed to execute 'generateKey' on 'SubtleCrypto': Algorithm: Unrecognized name`——用户看不懂。
 * 现在先探测能力，再用**人话**拒绝，并且 `canWrapFor` 如实回答"包不了"，让上层能跳过而不是整轮失败。
 *
 * （X25519 那条旧曲线已经不用了：能力探测检的是 **P-256**。）
 */

test('本机没有 P-256 能力时：canWrapFor 回答 false、wrapFor 用人话拒绝（不是 Unrecognized name）', async () => {
  const subtle = globalThis.crypto.subtle as unknown as {
    generateKey: (...args: unknown[]) => Promise<unknown>;
  };
  const realGenerateKey = subtle.generateKey.bind(subtle);
  subtle.generateKey = async (algorithm: unknown, ...rest: unknown[]) => {
    const name = (algorithm as { name?: string }).name;
    if (name === 'ECDH') {
      throw new Error("Failed to execute 'generateKey' on 'SubtleCrypto': Algorithm: Unrecognized name");
    }
    return realGenerateKey(algorithm, ...rest);
  };

  try {
    const port = createWebCryptoKeyWrap();
    // 先用一把**真的** P-256 公钥（在打桩之前生成不了，所以这里借一份固定的合法编码：全 0 曲线点是无效点，
    // 但长度对就足以走到"能力探测"这一步——包装在探测失败时根本不会去导入公钥）
    const p256PublicKey = '04' + '11'.repeat(64);
    assert.equal(await port.canWrapFor?.(p256PublicKey), false, '没有 P-256 能力就要如实回答包不了');
    await assert.rejects(
      () => port.wrapFor(p256PublicKey, new Uint8Array(32)),
      /没有可用的 P-256/,
      '要给"这台设备做不了这一步"的人话，而不是底层报错',
    );
  } finally {
    subtle.generateKey = realGenerateKey;
  }
});

test('同一台设备给 P-256 对端包装照常可用（正常路径不受影响）', async () => {
  const port = createWebCryptoKeyWrap();
  const keys = await port.generateAgreementKeys();
  const contentKey = await port.randomContentKey();
  const wrapped = await port.wrapFor(keys.publicKey, contentKey);
  const opened = await port.unwrapWith(keys.privateKey, keys.publicKey, wrapped);
  assert.deepEqual([...opened], [...contentKey]);
});
