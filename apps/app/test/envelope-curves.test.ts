import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyring, openKeyring } from '../../../packages/sync-core/src/keyring.ts';
import { createWebCryptoKeyWrap, curveOfPublicKey, detectKeyWrapSupport } from '../src/data/sync/envelope.ts';

/**
 * 包钥匙：**只剩 P-256**（旧曲线 X25519 的实现已删除，依据见 docs/M4-STATUS.md 第六十三节）。
 *
 * 背景（真机踩出来的）：最早用 X25519，但真机 WebView（Chrome）没有 WebCrypto X25519，
 * 于是真机根本加入不了共享目录 → 改成 **P-256**（全平台都有）。
 * 早期为了"旧记录仍能读"保留了 X25519 的读写分支；**现已删除**，因为线上不存在 X25519 包出来的钥匙包
 * （实测现网 keyring.json 只有一条 P-256 entry），而名单里残留的旧曲线公钥只需要"认出来并拒绝"。
 *
 * 这组测试盯四件事：P-256 往返、按长度识别旧曲线、旧曲线被明确拒绝、别人解不开。
 */

/** 32 字节 → 旧曲线。**刻意不造真的 X25519 密钥**：本版本不再有任何 X25519 代码。 */
const LEGACY_PUBLIC_KEY = '11'.repeat(32);

test('曲线识别：P-256 公钥 130 个十六进制字符，32 字节的一律算旧曲线', async () => {
  const port = createWebCryptoKeyWrap();
  const mine = await port.generateAgreementKeys();
  assert.equal(mine.publicKey.length, 130, 'P-256 的 raw 公钥应当是 130 个十六进制字符');
  assert.equal(curveOfPublicKey(mine.publicKey), 'P-256');
  assert.equal(curveOfPublicKey(LEGACY_PUBLIC_KEY), 'legacy', '32 字节的公钥只可能是已淘汰的旧曲线');
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

test('旧曲线对端：明确拒绝并让对方重新配对，canWrapFor 也如实回答"包不了"', async () => {
  const port = createWebCryptoKeyWrap();
  assert.equal(await port.canWrapFor?.(LEGACY_PUBLIC_KEY), false, '包不了就要说包不了（上层据此跳过）');
  await assert.rejects(
    () => port.wrapFor(LEGACY_PUBLIC_KEY, new Uint8Array(32)),
    /已淘汰的旧曲线/,
    '要给人话：说明这个对端用旧曲线、请重新配对（而不是底层的 Unrecognized name）',
  );
});

test('只有 P-256 收件人时：建库后名单里的人都能打开同一把数据钥匙', async () => {
  const port = createWebCryptoKeyWrap();
  const first = await port.generateAgreementKeys();
  const second = await port.generateAgreementKeys();
  const created = await createKeyring(
    port,
    [
      { deviceId: 'first', publicKey: first.publicKey },
      { deviceId: 'second', publicKey: second.publicKey },
    ],
    1,
  );

  const forFirst = await openKeyring(port, created.keyring, 'first', first.privateKey, first.publicKey);
  const forSecond = await openKeyring(port, created.keyring, 'second', second.privateKey, second.publicKey);
  assert.deepEqual([...forFirst], [...created.contentKey], '第一台设备能拿到数据钥匙');
  assert.deepEqual([...forSecond], [...created.contentKey], '第二台设备也能拿到同一把数据钥匙');
});

test('别人解不开：换一对密钥来解必须失败', async () => {
  const port = createWebCryptoKeyWrap();
  const mine = await port.generateAgreementKeys();
  const other = await port.generateAgreementKeys();
  const contentKey = await port.randomContentKey();
  const wrapped = await port.wrapFor(mine.publicKey, contentKey);
  await assert.rejects(() => port.unwrapWith(other.privateKey, other.publicKey, wrapped));
});
