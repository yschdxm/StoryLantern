import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureKeyring } from '../src/keyring-store.ts';
import { KEYRING_FILE, parseKeyring } from '../src/keyring.ts';
import { DeviceRosterList } from '../src/roster.ts';
import type { SyncBackend } from '../src/backend.ts';
import { createWebCryptoKeyWrap } from '../../../apps/app/src/data/sync/envelope.ts';
import { generateDeviceKeyPair } from '../../oplog/src/node-adapters.ts';

/**
 * 曲线换代（X25519 → P-256）之后的"建库跳过"。
 *
 * 真机场景：应用早已换成 P-256（真机 WebView 没有 X25519），但名单里还留着**旧曲线**的对端。
 * 建库必须给名单里每个对端包一遍钥匙，撞上包不了的就**硬失败**，报错还写成
 * 「请让支持它的设备来做建库/换代」——把责任推给了设备。
 *
 * 现在的规矩：**新建**时跳过包不了的对端并报上来（那把钥匙本来就没包给过它，不会让谁失去已有访问权）；
 * **换代**（已有钥匙包）时绝不跳过 —— 那等于把曾经有钥匙的成员悄悄踢出去。
 */

function backend(store: Map<string, Uint8Array>): SyncBackend {
  return {
    id: 'test-keyring-unwrappable',
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

test('建库：包不了的对端被跳过并列出来，别的对端照常包（不再整体失败）', async () => {
  const base = createWebCryptoKeyWrap();
  const mine = await base.generateAgreementKeys();
  const okPeer = await base.generateAgreementKeys();
  const oldCurve = await base.generateAgreementKeys();
  // 伪装成"本机不认识旧曲线"：只有那份旧公钥包不了
  const keyWrap = {
    ...base,
    async canWrapFor(publicKeyHex: string) {
      return publicKeyHex !== oldCurve.publicKey;
    },
  };
  const store = new Map<string, Uint8Array>();
  const roster = new DeviceRosterList([
    { deviceId: 'me', publicKey: generateDeviceKeyPair('me').publicKeyPem, addedAt: 1 },
    { deviceId: 'new-peer', publicKey: generateDeviceKeyPair('new-peer').publicKeyPem, addedAt: 2 },
    { deviceId: 'old-peer', publicKey: generateDeviceKeyPair('old-peer').publicKeyPem, addedAt: 3 },
  ]);

  const result = await ensureKeyring({
    backend: backend(store),
    deviceId: 'me',
    agreement: mine,
    keyWrap,
    peerAgreementKeys: { 'new-peer': okPeer.publicKey, 'old-peer': oldCurve.publicKey },
    roster,
  });

  assert.equal(result.mine, true, '空目录里应当由本机建库（不能因为一个对端包不了就整体失败）');
  assert.deepEqual(result.unwrappablePeers, ['old-peer'], '包不了的对端要如实报上来');
  const keyring = parseKeyring(new TextDecoder().decode(store.get(KEYRING_FILE) as Uint8Array));
  assert.deepEqual(
    keyring.entries.map((entry) => entry.deviceId).sort(),
    ['me', 'new-peer'],
    '能包的对端必须照常包进去，包不了的那个跳过',
  );
});

test('对照：端口没实现 canWrapFor 时视为"都能包"，一个都不许少', async () => {
  const keyWrap = createWebCryptoKeyWrap(); // 没有 canWrapFor
  const mine = await keyWrap.generateAgreementKeys();
  const peer = await keyWrap.generateAgreementKeys();
  const store = new Map<string, Uint8Array>();
  const roster = new DeviceRosterList([
    { deviceId: 'me', publicKey: generateDeviceKeyPair('me').publicKeyPem, addedAt: 1 },
    { deviceId: 'peer', publicKey: generateDeviceKeyPair('peer').publicKeyPem, addedAt: 2 },
  ]);

  const result = await ensureKeyring({
    backend: backend(store),
    deviceId: 'me',
    agreement: mine,
    keyWrap,
    peerAgreementKeys: { peer: peer.publicKey },
    roster,
  });

  assert.equal(result.unwrappablePeers, undefined, '不知道就别说"包不了"');
  const keyring = parseKeyring(new TextDecoder().decode(store.get(KEYRING_FILE) as Uint8Array));
  assert.deepEqual(keyring.entries.map((entry) => entry.deviceId).sort(), ['me', 'peer']);
});
