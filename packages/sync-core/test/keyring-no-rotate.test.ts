import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureKeyring } from '../src/keyring-store.ts';
import { createKeyring, KEYRING_FILE, serializeKeyring } from '../src/keyring.ts';
import { createWebCryptoKeyWrap } from '../../../apps/app/src/data/sync/envelope.ts';
import type { SyncBackend, BackendEntry, ListResult, PutResult } from '../src/backend.ts';

/**
 * **已加入的设备，不该因为"名单里还有对端没进钥匙包"就自己换代。**
 *
 * 真机踩到的事故：用户的实体手机（WebView 不认识 X25519）加入共享库成功之后，
 * 下一次同步却失败了——因为它走了一条"我在里面、但还有对端没进包 → 换代"的分支，
 * 而换代要给**每个**对端重包一遍钥匙，撞上旧 X25519 对端就在真机上直接抛错。
 *
 * 现在的行为：这种情况**只如实报告**（`pendingPeers`），不动共享目录。
 * 新设备加入本来走的是 `join/` + 接纳流程（那条路已被真机验证），不需要成员侧换代。
 */

interface CountingBackend extends SyncBackend {
  puts: number;
}

function memoryBackend(): CountingBackend {
  const files = new Map<string, Uint8Array>();
  return {
    puts: 0,
    id: 'test',
    capabilities: { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false },
    async list(prefix: string): Promise<ListResult> {
      const entries: BackendEntry[] = [...files.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, bytes]) => ({ path, size: bytes.length }));
      return { entries };
    },
    async get(path: string): Promise<Uint8Array> {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`not-found ${path}`);
      return bytes;
    },
    async put(path: string, bytes: Uint8Array): Promise<PutResult> {
      this.puts += 1;
      files.set(path, bytes);
      return { ok: true };
    },
  };
}

test('我在钥匙包里、但有对端还没进包：只报告 pendingPeers，不换代、不动共享目录', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const mine = await keyWrap.generateAgreementKeys();
  const other = await keyWrap.generateAgreementKeys();

  // 库里只有我自己那一份
  const created = await createKeyring(keyWrap, [{ deviceId: 'mine', publicKey: mine.publicKey }], 1);
  const backend = memoryBackend();
  await backend.put(KEYRING_FILE, new TextEncoder().encode(serializeKeyring(created.keyring)));
  const putsAfterSetup = backend.puts;

  const result = await ensureKeyring({
    backend,
    deviceId: 'mine',
    agreement: mine,
    keyWrap,
    peerAgreementKeys: { other: other.publicKey },
  });

  assert.equal(result.mine, true, '我在里面，就该按"库主人"对待自己这份');
  assert.equal(result.epoch, 1, '不该换代');
  assert.deepEqual(result.pendingPeers, ['other'], '如实报告还没进包的对端');
  assert.equal(
    backend.puts,
    putsAfterSetup,
    'ensureKeyring 不该写共享目录（换代要每个对端重包一遍，真机会撞 X25519）',
  );
});

test('别人包给我的库我打不开：只报告"我不在里面"，同样不动共享目录', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const owner = await keyWrap.generateAgreementKeys();
  const me = await keyWrap.generateAgreementKeys();

  const created = await createKeyring(keyWrap, [{ deviceId: 'owner', publicKey: owner.publicKey }], 1);
  const backend = memoryBackend();
  await backend.put(KEYRING_FILE, new TextEncoder().encode(serializeKeyring(created.keyring)));
  const putsAfterSetup = backend.puts;

  const result = await ensureKeyring({
    backend,
    deviceId: 'me',
    agreement: me,
    keyWrap,
    peerAgreementKeys: { owner: owner.publicKey },
  });

  assert.equal(result.mine, false, '没包给我就是"我不在里面"（该走加入流程）');
  assert.equal(result.epoch, 1);
  assert.equal(backend.puts, putsAfterSetup, '绝不换代：那会把别人锁在外面');
});
