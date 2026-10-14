import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromHex,
  signingPayload,
  toHex,
  verifySigned,
  type SignedEnvelope,
  type SignerPort,
} from '../src/signing.ts';

/**
 * 签名层的两条规则，都在这里钉住：
 *  1. **待签数据是确定性的**（用途 + 位置 + 摘要），否则换个上下文就能重放；
 *  2. **先看人再看签**——被移出名单的设备即使签得没问题也必须被拒绝。
 */

/** 假签名器：确定性异或，够用来验证流程与名单逻辑（真算法在 app 侧的 signer 测试里跑）。 */
function fakeSigner(deviceId: string): SignerPort {
  const key = Array.from(new TextEncoder().encode(deviceId)).reduce((sum, byte) => sum + byte, 7);
  const transform = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes, (byte) => byte ^ key);
  const publicKeyHex = `pub-${deviceId}`;
  return {
    algorithm: 'ed25519',
    deviceId,
    publicKeyHex,
    async sign(message) {
      return transform(message).slice(0, 32);
    },
    // 必须用"被声称那台设备"的公钥：拿错公钥就验不过
    async verify(claimedPublicKey, message, signature) {
      if (claimedPublicKey !== publicKeyHex) return false;
      const expected = transform(message).slice(0, 32);
      if (expected.length !== signature.length) return false;
      for (let index = 0; index < expected.length; index += 1) {
        if (expected[index] !== signature[index]) return false;
      }
      return true;
    },
  };
}

test('待签数据：用途 / 位置 / 摘要都参与，因此不能跨用途重放', () => {
  const a = signingPayload({ purpose: 'segment', ref: 'dev/1', digest: 'abcd' });
  const b = signingPayload({ purpose: 'roster', ref: 'dev/1', digest: 'abcd' });
  const c = signingPayload({ purpose: 'segment', ref: 'dev/2', digest: 'abcd' });
  const d = signingPayload({ purpose: 'segment', ref: 'dev/1', digest: 'abce' });
  const same = signingPayload({ purpose: 'segment', ref: 'dev/1', digest: 'abcd' });
  assert.deepEqual([...a], [...same]);
  for (const other of [b, c, d]) assert.notDeepEqual([...a], [...other]);
});

test('十六进制往返：坏输入返回 undefined 而不是抛错', () => {
  const bytes = Uint8Array.from([0, 1, 15, 16, 255]);
  assert.deepEqual([...(fromHex(toHex(bytes)) ?? [])], [...bytes]);
  assert.equal(fromHex(''), undefined);
  assert.equal(fromHex('abc'), undefined);
  assert.equal(fromHex('zz'), undefined);
});

test('验签：先看名单——被移出的设备签得对也不认', async () => {
  const signer = fakeSigner('device-a');
  const payload = signingPayload({ purpose: 'segment', ref: 's1/1', digest: 'aa' });
  const envelope: SignedEnvelope = { deviceId: 'device-a', algorithm: 'ed25519', signature: toHex(await signer.sign(payload)) };

  const active = new Set(['device-a', 'device-b']);
  assert.equal((await verifySigned(signer, envelope, payload, { active, revoked: new Set(), publicKeyOf: (id: string) => (id === 'device-a' ? 'pub-device-a' : 'pub-device-b') })).ok, true);

  const afterKick = await verifySigned(signer, envelope, payload, { active: new Set(['device-b']), revoked: new Set(['device-a']), publicKeyOf: () => 'pub-device-a' });
  assert.equal(afterKick.ok, false, '被踢之后旧签名不再被接受');
  assert.match(afterKick.reason ?? '', /移出名单/);

  const unknown = await verifySigned(signer, { ...envelope, deviceId: 'device-x' }, payload, {
    active,
    revoked: new Set(),
    publicKeyOf: () => 'pub-device-x',
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason ?? '', /不在名单里/);

  const foreign = await verifySigned(signer, { ...envelope, deviceId: 'device-b' }, payload, { active, revoked: new Set(), publicKeyOf: (id: string) => (id === 'device-a' ? 'pub-device-a' : 'pub-device-b') });
  assert.equal(foreign.ok, false, '别的设备冒充签名要被拒');
  assert.match(foreign.reason ?? '', /签名验证失败/);

  assert.equal((await verifySigned(signer, { ...envelope, signature: '' }, payload, { active, revoked: new Set(), publicKeyOf: (id: string) => (id === 'device-a' ? 'pub-device-a' : 'pub-device-b') })).ok, false);
  assert.equal(
    (await verifySigned(signer, { ...envelope, algorithm: 'hmac-sha256' }, payload, { active, revoked: new Set(), publicKeyOf: (id: string) => (id === 'device-a' ? 'pub-device-a' : 'pub-device-b') })).ok,
    false,
    '算法不一致要拒绝，避免"降级攻击"',
  );
});
