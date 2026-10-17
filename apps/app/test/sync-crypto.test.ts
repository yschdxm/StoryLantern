import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPasswordProofPort,
  createWebCryptoPorts,
  deriveSyncKeys,
  deriveSyncKeysV1,
  PBKDF2_ITERATIONS,
} from '../src/data/sync/crypto.ts';
import { toHex } from '../../../packages/oplog/src/bytes.ts';

/**
 * 口令派生的版本化：
 *  - v2 是 PBKDF2（慢 KDF），同一个口令派生结果稳定、不同口令不同；
 *  - v1（快 HKDF）只用于读旧加入证明，且与 v2 派生出的密钥不同；
 *  - 加入证明 v2 带 `v2:` 前缀；旧格式用 v1 密钥校验（只读兼容）。
 */

test('KDF v2：同一口令派生结果稳定，不同口令不同', async () => {
  const a = await deriveSyncKeys('correct horse battery staple');
  const b = await deriveSyncKeys('correct horse battery staple');
  const c = await deriveSyncKeys('correct horse battery stapl3');
  assert.equal(toHex(a.blindKey), toHex(b.blindKey));
  assert.notEqual(toHex(a.blindKey), toHex(c.blindKey));
  assert.ok(PBKDF2_ITERATIONS >= 200_000);
});

test('KDF v1 与 v2 派生出的盲化密钥不同（避免"看起来升级了其实同一把"）', async () => {
  const v1 = await deriveSyncKeysV1('same-secret');
  const v2 = await deriveSyncKeys('same-secret');
  assert.notEqual(toHex(v1.blindKey), toHex(v2.blindKey));
});

test('加入证明 v2：往返成功、换个口令解不开、带 v2 前缀', async () => {
  const keys = await deriveSyncKeys('join-secret');
  const port = createPasswordProofPort(keys);
  const payload = new TextEncoder().encode('storylantern/join/v1/device-a/abcd');
  const sealed = await port.seal(payload);
  assert.ok(sealed.startsWith('v2:'), '新证明必须带版本前缀');
  assert.deepEqual(await port.open(sealed), payload);

  const wrong = createPasswordProofPort(await deriveSyncKeys('wrong-secret'));
  await assert.rejects(() => wrong.open(sealed));
});

test('旧加入证明（无前缀）仍能用 v1 兼容密钥校验；只给 v2 时明确报错', async () => {
  const v1Keys = await deriveSyncKeysV1('legacy-secret');
  const payload = new TextEncoder().encode('legacy payload');
  const cipher = createWebCryptoPorts(v1Keys).cipher;
  assert.ok(cipher);
  const sealed = await cipher.seal(payload, new TextEncoder().encode('storylantern/join-proof/v1'));
  const combined = new Uint8Array(sealed.nonce.length + sealed.ciphertext.length);
  combined.set(sealed.nonce, 0);
  combined.set(sealed.ciphertext, sealed.nonce.length);
  let binary = '';
  for (const byte of combined) binary += String.fromCharCode(byte);
  const legacyProof = btoa(binary);
  assert.ok(!legacyProof.startsWith('v2:'));

  const withLegacy = createPasswordProofPort(await deriveSyncKeys('legacy-secret'), v1Keys);
  assert.deepEqual(await withLegacy.open(legacyProof), payload);

  const v2Only = createPasswordProofPort(await deriveSyncKeys('legacy-secret'));
  await assert.rejects(() => v2Only.open(legacyProof), /旧版本格式/);
});
