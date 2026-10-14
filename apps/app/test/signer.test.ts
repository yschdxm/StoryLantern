import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceSigner, detectSigningAlgorithm, SIGNING_KEY_KEY } from '../src/data/sync/signer.ts';
import { signingPayload, toHex, verifySigned, type SignedEnvelope } from '../../../packages/sync-core/src/signing.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import type { DeviceStore } from '../src/data/op-ports.ts';

/**
 * 本机签名器：**用真的 WebCrypto 跑**（Node 与浏览器是同一套 API），
 * 所以这里验证的是真实行为，不是打桩。
 *
 * 三条必须成立：
 *  1. 本机签的，用**本机公钥**验得过；
 *  2. 用**别人的公钥**验不过（这条是"证明是哪台设备写的"的核心）；
 *  3. 内容改一个字就验不过。
 */

function deviceStore(): DeviceStore {
  const store = createMemoryKeyValue();
  return {
    async get(key) {
      return store.read(key);
    },
    async set(key, value) {
      store.write(key, value);
    },
  };
}

const ALGO = await detectSigningAlgorithm();

test('签名器：探测能力并给出算法（Node 里应当是 ed25519）', () => {
  assert.ok(ALGO === 'ed25519' || ALGO === 'hmac-sha256');
  // Node 22 的 WebCrypto 支持 Ed25519；若这里变成弱模式，说明环境退化，测试仍然要能跑
  assert.equal(ALGO, 'ed25519');
});

test('签名器：密钥只生成一次并落在设备本地，重启后还是同一把', async () => {
  const device = deviceStore();
  const first = await createDeviceSigner({ deviceId: 'device-a', device, secret: 's' });
  const saved = await device.get(SIGNING_KEY_KEY);
  assert.ok(saved !== undefined && saved !== '');
  assert.equal(first.publicKeyHex.length > 0, true, '强模式必须有可发布的公钥');

  const second = await createDeviceSigner({ deviceId: 'device-a', device, secret: 's' });
  assert.equal(second.publicKeyHex, first.publicKeyHex, '重启不该换身份');

  const payload = signingPayload({ purpose: 'segment', ref: 's1/1', digest: 'aa' });
  const signature = await first.port.sign(payload);
  // 换一把签名器（同一个身份）签出来的，用同一把公钥也要能验
  assert.equal(await second.port.verify(first.publicKeyHex, payload, signature), true);
});

test('签名器：本机签的用本机公钥验得过；用别人的公钥验不过；改内容也验不过', async () => {
  const deviceA = deviceStore();
  const deviceB = deviceStore();
  const a = await createDeviceSigner({ deviceId: 'device-a', device: deviceA, secret: 's' });
  const b = await createDeviceSigner({ deviceId: 'device-b', device: deviceB, secret: 's' });
  assert.notEqual(a.publicKeyHex, b.publicKeyHex, '每台设备的公钥必须不同');

  const payload = signingPayload({ purpose: 'segment', ref: 's1/1', digest: 'aa' });
  const signature = await a.port.sign(payload);

  assert.equal(await a.port.verify(a.publicKeyHex, payload, signature), true, '本机公钥能验本机的签');
  assert.equal(await a.port.verify(b.publicKeyHex, payload, signature), false, '别人的公钥验不过——这才叫"确知是谁写的"');

  const tampered = signingPayload({ purpose: 'segment', ref: 's1/1', digest: 'ab' });
  assert.equal(await a.port.verify(a.publicKeyHex, tampered, signature), false, '改一个字节就验不过');
  assert.equal(await a.port.verify(a.publicKeyHex, payload, signature.slice(0, 32)), false, '截断的签名验不过');
});

test('验签 + 名单：走完整流程（含"名单里没有公钥就拒绝"）', async () => {
  const a = await createDeviceSigner({ deviceId: 'device-a', device: deviceStore(), secret: 's' });
  const b = await createDeviceSigner({ deviceId: 'device-b', device: deviceStore(), secret: 's' });
  const payload = signingPayload({ purpose: 'segment', ref: 's1/2', digest: 'bb' });
  const envelope: SignedEnvelope = {
    deviceId: 'device-a',
    algorithm: a.algorithm,
    signature: toHex(await a.port.sign(payload)),
  };

  const roster = {
    active: new Set(['device-a', 'device-b']),
    revoked: new Set<string>(),
    publicKeyOf: (deviceId: string) => (deviceId === 'device-a' ? a.publicKeyHex : b.publicKeyHex),
  };
  assert.equal((await verifySigned(b.port, envelope, payload, roster)).ok, true, 'a 写的，b 能验（用 a 的公钥）');

  const revoked = { ...roster, active: new Set(['device-b']), revoked: new Set(['device-a']) };
  const kicked = await verifySigned(b.port, envelope, payload, revoked);
  assert.equal(kicked.ok, false, '被移出名单后，它的旧签名不再被接受');
  assert.match(kicked.reason ?? '', /移出名单/);

  const noKey = { ...roster, publicKeyOf: () => undefined };
  const missing = await verifySigned(b.port, envelope, payload, noKey);
  assert.equal(missing.ok, false, '拿不到对方公钥时必须拒绝，而不是退化成"自己签自己验"');
  assert.match(missing.reason ?? '', /公钥/);

  const forged: SignedEnvelope = { ...envelope, deviceId: 'device-b' };
  const forgedOutcome = await verifySigned(b.port, forged, payload, roster);
  assert.equal(forgedOutcome.ok, false, 'b 冒充 a：用 a 的公钥验 b 的签，必然失败');
});

test('设备密钥与口令无关：改了口令，身份不变（这就是「永久且唯一」的含义）', async () => {
  const device = deviceStore();
  const first = await createDeviceSigner({ deviceId: 'device-a', device, secret: 'old-secret' });
  const second = await createDeviceSigner({ deviceId: 'device-a', device, secret: 'new-secret' });
  // 强模式（Ed25519）下设备密钥存在本机 kv 里，**不是**从口令派生的：
  // 换同步口令不该换掉这台机器的身份，否则它在别人眼里就成了另一台设备。
  if (first.algorithm === 'ed25519') {
    assert.equal(second.publicKeyHex, first.publicKeyHex);
  } else {
    // 弱模式是组内共享密钥，没有逐设备身份可用（界面上也如实这么写）
    assert.equal(first.publicKeyHex, '');
  }
});
