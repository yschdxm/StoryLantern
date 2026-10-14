import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RECOVERY_FILE,
  parseRecoveryFile,
  recoveryPayload,
  serializeRecoveryFile,
  signJoinWithRecovery,
  verifyRecoverySignature,
  type RecoveryProofPort,
} from '../src/recovery.ts';
import {
  createJoinRequest,
  parseJoinRequest,
  serializeJoinRequest,
  verifyJoinRequest,
  type JoinProofPort,
} from '../src/join.ts';

/**
 * 恢复密钥：**忘记同步口令时把设备接回来**。
 *
 * 三条要点：
 *  1. 签名绑定设备与时间（别人的恢复签名搬不过来、旧签名不好重放）；
 *  2. 共享目录里只放**公钥**——任何已授权设备都能验，但谁也拿不到私钥；
 *  3. 加入流程里"口令证明"与"恢复证明"是**二选一**，且黑名单仍然优先。
 */

/** 假恢复端口：xor 当签名（只要能区分"是谁签的"就够验证流程）。 */
function fakeRecovery(): RecoveryProofPort {
  const keyOf = (privateKey: string): string => `pub:${privateKey}`;
  return {
    async generate() {
      return { publicKey: 'pub:owner', privateKey: 'owner' };
    },
    async sign(privateKeyHex, payload) {
      const key = Array.from(new TextDecoder().decode(payload)).reduce((sum, ch) => sum + ch.charCodeAt(0), 7);
      let binary = '';
      for (const byte of new TextEncoder().encode(`${keyOf(privateKeyHex)}|${key}`)) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    async verify(publicKeyHex, payload, signatureHex) {
      const expected = await this.sign('', payload);
      const owner = await this.sign(publicKeyHex.replace('pub:', ''), payload);
      return publicKeyHex.startsWith('pub:') && (signatureHex === owner || signatureHex === expected);
    },
  };
}

/** 假口令端口：和 join.test.ts 里那份同形。 */
function fakeProof(secret: string): JoinProofPort {
  const key = Array.from(new TextEncoder().encode(secret)).reduce((sum, byte) => sum + byte, 7);
  const xform = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes, (byte) => byte ^ key);
  return {
    async seal(plaintext) {
      let binary = '';
      for (const byte of xform(plaintext)) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    async open(sealed) {
      const binary = atob(sealed);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return xform(bytes);
    },
  };
}

const device = { deviceId: 'newbie', publicKey: 'pub-newbie', agreementKey: 'agree-newbie' };

test('恢复密钥文件：读写与坏数据报错', () => {
  const file = { v: 1 as const, publicKey: 'pub:owner', createdAt: 1700 };
  assert.deepEqual(parseRecoveryFile(serializeRecoveryFile(file)), file);
  assert.throws(() => parseRecoveryFile('不是 json'), /不是合法 JSON/);
  assert.throws(() => parseRecoveryFile('{"v":2,"publicKey":"x","createdAt":1}'), /版本不认识/);
  assert.throws(() => parseRecoveryFile('{"v":1,"createdAt":1}'), /缺少公钥/);
});

test('恢复签名绑定设备与时间：换设备或换时间都验不过', async () => {
  const port = fakeRecovery();
  const file = { v: 1 as const, publicKey: 'pub:owner', createdAt: 1 };
  const signature = await signJoinWithRecovery(port, { privateKey: 'owner', deviceId: 'newbie', at: 1000 });

  assert.equal((await verifyRecoverySignature(port, file, { deviceId: 'newbie', at: 1000, signature })).ok, true);
  assert.equal((await verifyRecoverySignature(port, file, { deviceId: 'other', at: 1000, signature })).ok, false);
  assert.equal((await verifyRecoverySignature(port, file, { deviceId: 'newbie', at: 2000, signature })).ok, false);
  assert.equal((await verifyRecoverySignature(port, file, { deviceId: 'newbie', at: 1000, signature: '' })).ok, false);
  assert.equal(
    (await verifyRecoverySignature(port, { ...file, publicKey: '' }, { deviceId: 'newbie', at: 1000, signature })).ok,
    false,
  );
});

test('加入流程：没有口令，但有恢复证明 → 接受（这就是「用恢复密钥重置口令」）', async () => {
  const port = fakeRecovery();
  const recoveryFile = { v: 1 as const, publicKey: 'pub:owner', createdAt: 1 };
  const at = 5000;
  const recoveryProof = await signJoinWithRecovery(port, { privateKey: 'owner', deviceId: device.deviceId, at });

  const request = await createJoinRequest(fakeProof('some-secret'), { ...device, at, recoveryProof });
  assert.equal(request.proof, '', '带恢复证明时不必有口令证明');
  assert.deepEqual(parseJoinRequest(serializeJoinRequest(request)), request);

  const accepted = await verifyJoinRequest(fakeProof('who-knows'), request, {
    revoked: new Set(),
    verifyRecovery: (item) =>
      verifyRecoverySignature(port, recoveryFile, {
        deviceId: item.deviceId,
        at: item.at,
        signature: item.recoveryProof ?? '',
      }),
  });
  assert.equal(accepted.ok, true);
});

test('加入流程：既没有口令也没有恢复证明 → 拒绝；有恢复证明但没有恢复公钥 → 也拒绝', async () => {
  const port = fakeRecovery();
  // 直接构造一份"既没有口令证明、也没有恢复证明"的请求
  const bare = {
    v: 1 as const,
    deviceId: device.deviceId,
    publicKey: device.publicKey,
    agreementKey: device.agreementKey,
    proof: '',
    at: 1,
  };

  assert.equal((await verifyJoinRequest(fakeProof('s'), bare, { revoked: new Set() })).ok, false);

  const withProof = await createJoinRequest(fakeProof('s'), {
    ...device,
    at: 2,
    recoveryProof: await signJoinWithRecovery(port, { privateKey: 'owner', deviceId: device.deviceId, at: 2 }),
  });
  const noVerifier = await verifyJoinRequest(fakeProof('s'), withProof, { revoked: new Set() });
  assert.equal(noVerifier.ok, false);
  assert.match(noVerifier.reason ?? '', /还没有恢复公钥/);
});

test('加入流程：黑名单仍然优先——有恢复证明也不许被永久禁用的设备回来', async () => {
  const port = fakeRecovery();
  const recoveryFile = { v: 1 as const, publicKey: 'pub:owner', createdAt: 1 };
  const at = 9000;
  const request = await createJoinRequest(fakeProof('s'), {
    ...device,
    at,
    recoveryProof: await signJoinWithRecovery(port, { privateKey: 'owner', deviceId: device.deviceId, at }),
  });
  const outcome = await verifyJoinRequest(fakeProof('s'), request, {
    revoked: new Set([device.deviceId]),
    verifyRecovery: (item) =>
      verifyRecoverySignature(port, recoveryFile, { deviceId: item.deviceId, at: item.at, signature: item.recoveryProof ?? '' }),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? '', /永久禁用/);
});

test('恢复文件路径：放在共享目录根上的明文文件（公钥不是秘密）', () => {
  assert.equal(RECOVERY_FILE, 'recovery.json');
  assert.equal(recoveryPayload({ deviceId: 'a', at: 1 }).length > 0, true);
});
