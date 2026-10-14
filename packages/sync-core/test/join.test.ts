import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJoinRequest,
  joinPath,
  parseJoinRequest,
  serializeJoinRequest,
  verifyJoinRequest,
  type JoinProofPort,
} from '../src/join.ts';

/**
 * 加入请求：**密码是门，签名是身份，黑名单优先**。
 *
 * 用假端口跑（真密码学在 app 侧接到"密码派生的钥匙"上），把三条规则钉住：
 *  1. 只有知道口令的（能解开证明的）请求才算数；
 *  2. 证明与请求内容绑定：把别人的证明搬到自己的请求上必须失败；
 *  3. **黑名单优先**：被永久禁用的设备即使能解开证明，也不许重新进来。
 */

/** 假端口：xor 当"加密"，够用来验证流程与绑定关系。 */
function fakePort(secret: string): JoinProofPort {
  const key = Array.from(new TextEncoder().encode(secret)).reduce((sum, byte) => sum + byte, 7);
  const xform = (bytes: Uint8Array): Uint8Array => Uint8Array.from(bytes, (byte) => byte ^ key);
  return {
    async seal(plaintext) {
      const mixed = xform(plaintext);
      let binary = '';
      for (const byte of mixed) binary += String.fromCharCode(byte);
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

const device = { deviceId: 'bob', publicKey: 'pub-bob', agreementKey: 'agree-bob' };

test('加入路径：明文区、按设备命名', () => {
  assert.equal(joinPath('bob'), 'join/bob.json');
});

test('加入请求：知道口令就能通过，不知道的口令解不开', async () => {
  const good = fakePort('shared-secret');
  const bad = fakePort('wrong-secret');
  const request = await createJoinRequest(good, { ...device, at: 1000 });

  const accepted = await verifyJoinRequest(good, request, { revoked: new Set() });
  assert.equal(accepted.ok, true);

  const rejected = await verifyJoinRequest(bad, request, { revoked: new Set() });
  assert.equal(rejected.ok, false);
  // 真实现是 AEAD：口令不对会**抛错**（走"解不开"这条）；
  // 这里的假端口是 xor，解出来是乱码，于是走"与请求内容不符"。两条都必须拒绝。
  assert.match(rejected.reason ?? '', /解不开|与请求内容不符/);
});

test('加入请求：证明与内容绑定——把证明搬到别的公钥上必须失败', async () => {
  const port = fakePort('shared-secret');
  const request = await createJoinRequest(port, { ...device, at: 1000 });
  const tampered = { ...request, publicKey: 'pub-attacker' };
  const outcome = await verifyJoinRequest(port, tampered, { revoked: new Set() });
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason ?? '', /与请求内容不符/);
});

test('黑名单优先：被永久禁用的设备即使知道口令也不许进来', async () => {
  const port = fakePort('shared-secret');
  const request = await createJoinRequest(port, { ...device, at: 1000 });
  const outcome = await verifyJoinRequest(port, request, { revoked: new Set(['bob']) });
  assert.equal(outcome.ok, false, '它知道门码也没用');
  assert.match(outcome.reason ?? '', /永久禁用/);
});

test('重复的旧请求不重复处理（幂等），新请求照常处理', async () => {
  const port = fakePort('shared-secret');
  const older = await createJoinRequest(port, { ...device, at: 1000 });
  const newer = await createJoinRequest(port, { ...device, at: 2000 });
  const knownSince = () => 1500;

  assert.equal((await verifyJoinRequest(port, older, { revoked: new Set(), knownSince })).ok, false);
  assert.equal((await verifyJoinRequest(port, newer, { revoked: new Set(), knownSince })).ok, true);
});

test('加入请求的读写：缺字段要说清缺哪个', async () => {
  const port = fakePort('shared-secret');
  const request = await createJoinRequest(port, { ...device, at: 1000 });
  assert.deepEqual(parseJoinRequest(serializeJoinRequest(request)), request);
  assert.throws(() => parseJoinRequest('{}'), /版本不认识/);
  assert.throws(() => parseJoinRequest('{"v":1,"deviceId":"a"}'), /缺少 publicKey/);
  assert.throws(() => parseJoinRequest('不是 json'), /不是合法 JSON/);
});

test('不给协商公钥就等于"别人没法把钥匙包给你"：直接拒绝生成', async () => {
  const port = fakePort('shared-secret');
  await assert.rejects(() => createJoinRequest(port, { ...device, agreementKey: '' }), /协商公钥/);
  await assert.rejects(() => createJoinRequest(port, { ...device, publicKey: '' }), /签名公钥/);
});
