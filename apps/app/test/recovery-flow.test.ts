import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptJoinRequests, publishJoinRequest } from '../src/data/sync/join-flow.ts';
import { createWebCryptoRecoveryProof } from '../src/data/sync/recovery-key.ts';
import { createWebCryptoKeyWrap } from '../src/data/sync/envelope.ts';
import {
  signJoinWithRecovery,
  verifyRecoverySignature,
  RECOVERY_FILE,
} from '../../../packages/sync-core/src/recovery.ts';
import { createKeyring, openKeyring, parseKeyring, KEYRING_FILE } from '../../../packages/sync-core/src/keyring.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { parseJoinRequest, joinPath } from '../../../packages/sync-core/src/join.ts';
import type { DeviceStore } from '../src/data/op-ports.ts';
import type { SyncBackend, BackendEntry, ListResult, PutResult } from '../../../packages/sync-core/src/backend.ts';
import type { JoinProofPort } from '../../../packages/sync-core/src/join.ts';

/**
 * 恢复密钥的**端到端**（真 Ed25519）：忘记同步口令的设备也能被接回共享目录。
 *
 * 链条：库主人建号 → 新设备没有口令、只用恢复私钥签一份恢复证明 → 已授权设备验签后
 * 把当前数据钥匙包给它 → 它真的能解开。
 */

function memoryBackend(): SyncBackend & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    id: 'memory',
    capabilities: { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false },
    async list(prefix: string): Promise<ListResult> {
      const entries: BackendEntry[] = [...files.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, bytes]) => ({ path, size: bytes.length }));
      return { entries };
    },
    async get(path: string): Promise<Uint8Array> {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`404 找不到 ${path}`);
      return bytes;
    },
    async put(path: string, bytes: Uint8Array): Promise<PutResult> {
      files.set(path, bytes);
      return { ok: true };
    },
  };
}

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

/** 口令端口：xor 当加密（这一条测的是恢复路，口令故意用错）。 */
function wrongPasswordProof(): JoinProofPort {
  const key = 7;
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

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test('恢复密钥（端到端）：没口令的新设备靠恢复签名被接纳，并拿到同一把数据钥匙', async () => {
  const backend = memoryBackend();
  const keyWrap = createWebCryptoKeyWrap();
  const recovery = createWebCryptoRecoveryProof();
  const pair = await recovery.generate();

  // 库主人公布恢复公钥
  await backend.put(RECOVERY_FILE, encode(JSON.stringify({ v: 1, publicKey: pair.publicKey, createdAt: 1 })));

  // 库主人建号（epoch 1，只包给自己）
  const host = await keyWrap.generateAgreementKeys();
  const created = await createKeyring(keyWrap, [{ deviceId: 'host', publicKey: host.publicKey }], 1);
  await backend.put(KEYRING_FILE, encode(JSON.stringify(created.keyring)));

  // 新设备：**没有口令**，只有离线保存的恢复私钥
  const joiner = await keyWrap.generateAgreementKeys();
  const at = 7777;
  const recoveryProof = await signJoinWithRecovery(recovery, {
    privateKey: pair.privateKey,
    deviceId: 'joiner',
    at,
  });
  await publishJoinRequest({
    backend,
    deviceId: 'joiner',
    publicKey: 'pub-joiner',
    agreementKey: joiner.publicKey,
    joinProof: wrongPasswordProof(), // 口令这条路是错的（模拟"忘了口令"）
    recoveryProof,
    now: () => at,
  });

  const outcome = await acceptJoinRequests({
    backend,
    device: deviceStore(),
    keyWrap,
    contentKey: created.contentKey,
    banned: new Set(),
    joinProof: wrongPasswordProof(), // 接纳方的口令也不对 → 只能靠恢复证明
    selfId: 'host',
    recoveryProof: recovery,
    recoveryPublicKey: pair.publicKey,
  });

  assert.deepEqual(outcome.accepted, ['joiner'], '恢复签名应当被接受');
  const keyring = parseKeyring(decode(await backend.get(KEYRING_FILE)));
  const forJoiner = await openKeyring(keyWrap, keyring, 'joiner', joiner.privateKey, joiner.publicKey);
  assert.deepEqual([...forJoiner], [...created.contentKey], '新设备拿到的是同一把数据钥匙');
});

test('恢复密钥（端到端）：换一把恢复密钥签的证明不被接受', async () => {
  const backend = memoryBackend();
  const keyWrap = createWebCryptoKeyWrap();
  const recovery = createWebCryptoRecoveryProof();
  const published = await recovery.generate();
  const attacker = await recovery.generate();

  const host = await keyWrap.generateAgreementKeys();
  const created = await createKeyring(keyWrap, [{ deviceId: 'host', publicKey: host.publicKey }], 1);
  await backend.put(KEYRING_FILE, encode(JSON.stringify(created.keyring)));

  const joiner = await keyWrap.generateAgreementKeys();
  const at = 8888;
  const forged = await signJoinWithRecovery(recovery, {
    privateKey: attacker.privateKey, // 攻击者自己的恢复私钥
    deviceId: 'joiner',
    at,
  });
  await publishJoinRequest({
    backend,
    deviceId: 'joiner',
    publicKey: 'pub-joiner',
    agreementKey: joiner.publicKey,
    joinProof: wrongPasswordProof(),
    recoveryProof: forged,
    now: () => at,
  });

  const outcome = await acceptJoinRequests({
    backend,
    device: deviceStore(),
    keyWrap,
    contentKey: created.contentKey,
    banned: new Set(),
    joinProof: wrongPasswordProof(),
    selfId: 'host',
    recoveryProof: recovery,
    recoveryPublicKey: published.publicKey, // 只认公布的那把
  });

  assert.deepEqual(outcome.accepted, []);
  assert.equal(outcome.refused.length, 1);
  assert.match(outcome.refused[0]!.reason, /恢复|不符|解不开/);
});

test("用恢复私钥直接签（③ 的新路径）：请求里带出可验证的恢复证明", async () => {
  const backend = memoryBackend();
  const recovery = createWebCryptoRecoveryProof();
  const pair = await recovery.generate();
  const at = 4321;
  await publishJoinRequest({
    backend,
    deviceId: "joiner",
    publicKey: "pub-joiner",
    agreementKey: "agree-joiner",
    joinProof: wrongPasswordProof(),
    recoveryPrivateKey: pair.privateKey, // ← 界面粘进来的就是它
    now: () => at,
  });
  const stored = await backend.get(joinPath("joiner"));
  const request = parseJoinRequest(decode(stored));
  assert.equal(request.proof, "", "带恢复证明时不必有口令证明");
  const verdict = await verifyRecoverySignature(recovery, { v: 1, publicKey: pair.publicKey, createdAt: 0 }, {
    deviceId: "joiner",
    at,
    signature: request.recoveryProof ?? "",
  });
  assert.equal(verdict.ok, true, "公布的公钥应当能验证这份签名");
});
