import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureKeyring } from '../src/keyring-store.ts';
import { KEYRING_FILE, parseKeyring } from '../src/keyring.ts';
import { DeviceRosterList } from '../src/roster.ts';
import type { SyncBackend } from '../src/backend.ts';
import { createWebCryptoKeyWrap } from '../../../apps/app/src/data/sync/envelope.ts';
import { generateDeviceKeyPair } from '../../oplog/src/node-adapters.ts';

/**
 * 回归：**名单里没有的对端，不许出现在收件人里**。
 *
 * 真机事故：手机上点同步，报「这台设备的 WebView 不认识 X25519…没法给这个对端（3a34d6f1…）包钥匙：
 * 请让支持它的设备来做建库/换代」。查下来不是设备的问题 —— 是 `peerAgreementKeys` 里留着一条
 * **早就被移除的旧对端**（历史累积），建库时把它也当收件人，于是本机包不了它的旧公钥 → 硬失败，
 * 而且报错把责任推给了设备。
 *
 * 这里把那条路钉住：给一个**不在名单里**的对端公钥（这里用一份合法的 X25519 公钥，确保失败原因
 * 只会是"该不该包它"，而不是"公钥不合法"），建库必须成功，且钥匙包里**只有本机**一份。
 */

function backend(store: Map<string, Uint8Array>): SyncBackend {
  return {
    id: 'test-keyring-stale-peer',
    capabilities: { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false },
    async list() {
      return { entries: [] };
    },
    async get(path: string): Promise<Uint8Array> {
      const value = store.get(path);
      if (value === undefined) throw new Error(`文件不存在：${path}`);
      return value;
    },
    async put(path: string, bytes: Uint8Array) {
      store.set(path, bytes);
      return { ok: true, bytes };
    },
  } as SyncBackend;
}

test('建库：名单外的旧对端不许被当成收件人（否则会硬失败并把责任推给设备）', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const mine = await keyWrap.generateAgreementKeys();
  const store = new Map<string, Uint8Array>();
  // 名单里只有本机；那份"旧对端"的公钥（另造一对合法的协商密钥）不在名单里
  const ghost = await keyWrap.generateAgreementKeys();
  const roster = new DeviceRosterList([
    { deviceId: 'me', addedAt: 1 },
  ]);

  const result = await ensureKeyring({
    backend: backend(store),
    deviceId: 'me',
    agreement: mine,
    keyWrap,
    peerAgreementKeys: { 'ghost-device': ghost.publicKey },
    roster,
  });

  assert.equal(result.mine, true, '空目录里应当由本机建库');
  const written = store.get(KEYRING_FILE);
  assert.ok(written !== undefined, '建好的钥匙包要真的写下去');
  const keyring = parseKeyring(new TextDecoder().decode(written));
  assert.deepEqual(
    keyring.entries.map((entry) => entry.deviceId),
    ['me'],
    '名单外的旧对端不该进钥匙包（修之前这里会是 me + ghost-device）',
  );
});

test('对照：名单里**在**的对端仍必须被包进去（别把正常的多设备也滤掉了）', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const mine = await keyWrap.generateAgreementKeys();
  const peer = await keyWrap.generateAgreementKeys();
  const store = new Map<string, Uint8Array>();
  const roster = new DeviceRosterList([
    { deviceId: 'me', addedAt: 1 },
    { deviceId: 'peer', addedAt: 2 },
  ]);

  await ensureKeyring({
    backend: backend(store),
    deviceId: 'me',
    agreement: mine,
    keyWrap,
    peerAgreementKeys: { peer: peer.publicKey },
    roster,
  });

  const written = store.get(KEYRING_FILE);
  const keyring = parseKeyring(new TextDecoder().decode(written as Uint8Array));
  assert.deepEqual(keyring.entries.map((entry) => entry.deviceId).sort(), ['me', 'peer']);
});
