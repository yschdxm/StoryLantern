import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureKeyring, readKeyring, rotateKeyring } from '../../../packages/sync-core/src/keyring-store.ts';
import { createKeyring, openKeyring, serializeKeyring, KEYRING_FILE } from '../../../packages/sync-core/src/keyring.ts';
import { createWebCryptoKeyWrap } from '../src/data/sync/envelope.ts';
import type { SyncBackend, BackendEntry, ListResult, PutResult } from '../../../packages/sync-core/src/backend.ts';

/**
 * 换代（永久禁用的另一半）：**新数据钥匙只包给留下的人**。
 *
 * 要钉住两条：
 *  1. 被禁用的人**开不了**新钥匙（这就是"它解不出以后的内容"）；
 *  2. 打不开 keyring 的设备**绝不换代**——换代要用名单里每台设备的协商公钥重新包，
 *     而它此刻不知道别人的公钥，换出来会把其它设备锁在外面。
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

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

test('换代：被禁用的人拿不到新钥匙（剩下的人照旧），且 epoch 递增', async () => {
  const backend = memoryBackend();
  const port = createWebCryptoKeyWrap();
  const a = await port.generateAgreementKeys();
  const b = await port.generateAgreementKeys();

  const first = await createKeyring(
    port,
    [
      { deviceId: 'a', publicKey: a.publicKey },
      { deviceId: 'b', publicKey: b.publicKey },
    ],
    1,
  );
  await backend.put(KEYRING_FILE, encode(serializeKeyring(first.keyring)));

  // 永久禁用 b：换代只包给 a
  const rotated = await rotateKeyring({ backend, keyWrap: port, recipients: [{ deviceId: 'a', publicKey: a.publicKey }] });
  assert.equal(rotated.keyring.epoch, 2);
  assert.notDeepEqual([...rotated.contentKey], [...first.contentKey], '换代必须换钥匙');

  const forA = await openKeyring(port, rotated.keyring, 'a', a.privateKey, a.publicKey);
  assert.deepEqual([...forA], [...rotated.contentKey], '留下的人拿得到新钥匙');

  await assert.rejects(
    () => openKeyring(port, rotated.keyring, 'b', b.privateKey, b.publicKey),
    /没有包给设备 b/,
    '被禁用的人开不了新钥匙——它的密钥"解不出"了',
  );
});

test('打不开 keyring 的设备**绝不换代**（否则会把其它设备锁在外面）', async () => {
  const backend = memoryBackend();
  const port = createWebCryptoKeyWrap();
  const a = await port.generateAgreementKeys();
  const b = await port.generateAgreementKeys();

  // 目录里那份只包给了 a
  const onlyA = await createKeyring(port, [{ deviceId: 'a', publicKey: a.publicKey }], 1);
  await backend.put(KEYRING_FILE, encode(serializeKeyring(onlyA.keyring)));

  const result = await ensureKeyring({ backend, deviceId: 'b', agreement: b, peerAgreementKeys: {}, keyWrap: port });
  assert.equal(result?.mine, false, '如实报告"我不在里面"');

  const after = await readKeyring(backend);
  assert.equal(after?.epoch, 1, '不能换代：epoch 必须还是 1');
  assert.deepEqual(
    after?.entries.map((entry) => entry.deviceId),
    ['a'],
    'entries 也不能被动过',
  );
});

test('ensureKeyring：钥匙包给我、而且覆盖了我认识的设备时，直接复用（不换代）', async () => {
  const backend = memoryBackend();
  const port = createWebCryptoKeyWrap();
  const a = await port.generateAgreementKeys();
  const b = await port.generateAgreementKeys();

  const both = await createKeyring(
    port,
    [
      { deviceId: 'a', publicKey: a.publicKey },
      { deviceId: 'b', publicKey: b.publicKey },
    ],
    3,
  );
  await backend.put(KEYRING_FILE, encode(serializeKeyring(both.keyring)));

  const result = await ensureKeyring({
    backend,
    deviceId: 'a',
    agreement: a,
    peerAgreementKeys: { b: b.publicKey },
    keyWrap: port,
  });
  assert.equal(result?.mine, true);
  assert.equal(result?.epoch, 3, '已覆盖全部已知设备：不该换代');
  if (result?.mine === true) assert.deepEqual([...result.contentKey], [...both.contentKey]);
});
