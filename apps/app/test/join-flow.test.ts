import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptJoinRequests, publishJoinRequest, JOIN_SEEN_KEY } from '../src/data/sync/join-flow.ts';
import { createWebCryptoKeyWrap } from '../src/data/sync/envelope.ts';
import { createKeyring, openKeyring, parseKeyring, KEYRING_FILE } from '../../../packages/sync-core/src/keyring.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import type { DeviceStore } from '../src/data/op-ports.ts';
import type { SyncBackend, BackendEntry, ListResult, PutResult } from '../../../packages/sync-core/src/backend.ts';
import type { JoinProofPort } from '../../../packages/sync-core/src/join.ts';

/**
 * 加入流程：**输密码进来 → 已授权设备把当前数据钥匙包给你**。
 *
 * 用真密码学（X25519 + AES-GCM）跑，因为这条路的正确性就是密码学性质的：
 *  1. 验过密码证明之后，新设备能打开 keyring 拿到**同一把**内容密钥（epoch 不变）；
 *  2. **黑名单优先**：被永久禁用的设备写来的请求不认，不会给它包钥匙；
 *  3. 重复处理是幂等的（本机记下已处理过的请求）。
 */

/** 最小内存后端（只需 list/get/put）。 */
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

/** 密码证明端口：用 xor 当"加密"，够用来验证"知道口令"这件事。 */
function proofPort(secret: string): JoinProofPort {
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

test('加入流程：验过密码证明就把当前数据钥匙包给新设备（epoch 不变，新设备能解开）', async () => {
  const backend = memoryBackend();
  const keyWrap = createWebCryptoKeyWrap();
  const secret = 'shared-secret';

  // 老设备（已授权）：建号并把钥匙包给自己
  const host = await keyWrap.generateAgreementKeys();
  const created = await createKeyring(keyWrap, [{ deviceId: 'host', publicKey: host.publicKey }], 1);
  await backend.put(KEYRING_FILE, new TextEncoder().encode(JSON.stringify(created.keyring)));

  // 新设备：写加入请求（带两把公钥 + 密码证明）
  const joiner = await keyWrap.generateAgreementKeys();
  const joinDevice = deviceStore();
  await publishJoinRequest({
    backend,
    deviceId: 'joiner',
    publicKey: 'pub-joiner',
    agreementKey: joiner.publicKey,
    joinProof: proofPort(secret),
  });

  const hostDevice = deviceStore();
  const outcome = await acceptJoinRequests({
    backend,
    device: hostDevice,
    keyWrap,
    contentKey: created.contentKey,
    banned: new Set(),
    joinProof: proofPort(secret),
    selfId: 'host',
  });

  assert.deepEqual(outcome.accepted, ['joiner'], '应当接受并把它加进 keyring');
  assert.deepEqual(outcome.refused, []);

  const keyring = parseKeyring(new TextDecoder().decode(await backend.get(KEYRING_FILE)));
  assert.equal(keyring.epoch, 1, '**epoch 不变**：只是多一个人能解开同一把钥匙');
  const forJoiner = await openKeyring(keyWrap, keyring, 'joiner', joiner.privateKey, joiner.publicKey);
  assert.deepEqual([...forJoiner], [...created.contentKey], '新设备拿到的必须是同一把内容密钥');

  // 幂等：同一个设备（已处理记录在本机）再跑一次不会重复处理
  const again = await acceptJoinRequests({
    backend,
    device: hostDevice,
    keyWrap,
    contentKey: created.contentKey,
    banned: new Set(),
    joinProof: proofPort(secret),
    selfId: 'host',
  });
  assert.deepEqual(again.accepted, []);
});

test('加入流程：黑名单优先——被永久禁用的设备即使知道口令也拿不到钥匙', async () => {
  const backend = memoryBackend();
  const keyWrap = createWebCryptoKeyWrap();
  const secret = 'shared-secret';
  const host = await keyWrap.generateAgreementKeys();
  const created = await createKeyring(keyWrap, [{ deviceId: 'host', publicKey: host.publicKey }], 1);
  await backend.put(KEYRING_FILE, new TextEncoder().encode(JSON.stringify(created.keyring)));

  const bannedKeys = await keyWrap.generateAgreementKeys();
  await publishJoinRequest({
    backend,
    deviceId: 'banned-device',
    publicKey: 'pub-banned',
    agreementKey: bannedKeys.publicKey,
    joinProof: proofPort(secret),
  });

  const outcome = await acceptJoinRequests({
    backend,
    device: deviceStore(),
    keyWrap,
    contentKey: created.contentKey,
    banned: new Set(['banned-device']),
    joinProof: proofPort(secret),
    selfId: 'host',
  });

  assert.deepEqual(outcome.accepted, [], '不许给它包钥匙');
  assert.equal(outcome.refused.length, 1);
  assert.match(outcome.refused[0]!.reason, /永久禁用/);

  const keyring = parseKeyring(new TextDecoder().decode(await backend.get(KEYRING_FILE)));
  assert.equal(keyring.entries.some((entry) => entry.deviceId === 'banned-device'), false, 'keyring 里不应有它');
});

test('加入流程：口令不对的请求不认（证明解不开）', async () => {
  const backend = memoryBackend();
  const keyWrap = createWebCryptoKeyWrap();
  const host = await keyWrap.generateAgreementKeys();
  const created = await createKeyring(keyWrap, [{ deviceId: 'host', publicKey: host.publicKey }], 1);
  await backend.put(KEYRING_FILE, new TextEncoder().encode(JSON.stringify(created.keyring)));

  const other = await keyWrap.generateAgreementKeys();
  await publishJoinRequest({
    backend,
    deviceId: 'stranger',
    publicKey: 'pub-stranger',
    agreementKey: other.publicKey,
    joinProof: proofPort('someone-elses-secret'),
  });

  const outcome = await acceptJoinRequests({
    backend,
    device: deviceStore(),
    keyWrap,
    contentKey: created.contentKey,
    banned: new Set(),
    joinProof: proofPort('shared-secret'), // 我这边是"正确口令"
    selfId: 'host',
  });

  assert.deepEqual(outcome.accepted, []);
  assert.equal(outcome.refused.length, 1);
  assert.match(outcome.refused[0]!.reason, /解不开|不符/);
});

test('加入流程：处理过的请求记在本机（避免重复包钥匙）', async () => {
  const backend = memoryBackend();
  const keyWrap = createWebCryptoKeyWrap();
  const host = await keyWrap.generateAgreementKeys();
  const created = await createKeyring(keyWrap, [{ deviceId: 'host', publicKey: host.publicKey }], 1);
  await backend.put(KEYRING_FILE, new TextEncoder().encode(JSON.stringify(created.keyring)));

  const joiner = await keyWrap.generateAgreementKeys();
  await publishJoinRequest({
    backend,
    deviceId: 'joiner',
    publicKey: 'pub-joiner',
    agreementKey: joiner.publicKey,
    joinProof: proofPort('shared-secret'),
    now: () => 5000,
  });

  const device = deviceStore();
  await acceptJoinRequests({ backend, device, keyWrap, contentKey: created.contentKey, banned: new Set(), joinProof: proofPort('shared-secret'), selfId: 'host' });
  const recorded = await device.get(JOIN_SEEN_KEY);
  assert.ok(recorded !== undefined && recorded.includes('joiner'));
});
