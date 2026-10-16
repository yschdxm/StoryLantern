import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  DeviceRosterList,
  type RosterStampPort,
} from '../../../packages/sync-core/src/index.ts';
import {
  ROSTER_KEY,
  getManagementKey,
  loadRoster,
  loadRosterChecked,
  saveRoster,
  saveStampedRoster,
  setManagementKey,
} from '../src/data/sync/roster-store.ts';

/**
 * 名单盖章在**应用侧**的接线（`roster-store.ts`）。
 *
 * 核心逻辑在 `packages/sync-core` 里已有 5 条测试；这里钉的是这一层的三条行为：
 *  1. 旧路径 `loadRoster` 不受影响；
 *  2. `loadRosterChecked` 在本机配了管理密钥时，未盖章的名单**不认**（trust 如实返回，交给调用方拒绝）；
 *  3. `saveStampedRoster` 盖完章之后，同一台机器再读就是 `stamped-verified`。
 */

function makePort(): { port: RosterStampPort; privateHex: string; publicHex: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateHex: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex'),
    publicHex: publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    port: {
      async sign(privateKeyHex, payload) {
        return sign(null, Buffer.from(payload), createPrivateKey({ key: Buffer.from(privateKeyHex, 'hex'), format: 'der', type: 'pkcs8' })).toString('hex');
      },
      async verify(publicKeyHex, payload, signatureHex) {
        return verify(
          null,
          Buffer.from(payload),
          createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' }),
          Buffer.from(signatureHex, 'hex'),
        );
      },
    },
  };
}

/** 最小的设备 kv（只有 get/set 两个动作，与 DeviceStore 的形状一致）。 */
function makeDevice() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) {
      return store.get(key);
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async remove(key: string) {
      store.delete(key);
    },
    async keys() {
      return [...store.keys()];
    },
  };
}

const NOW = 1_700_000_000_000;
const roster = () =>
  new DeviceRosterList([
    { deviceId: 'device-a', publicKey: 'pem-a', addedAt: NOW },
    { deviceId: 'device-b', publicKey: 'pem-b', addedAt: NOW + 1 },
  ]);

test('旧路径不受影响：没盖章的名单照旧读得出来', async () => {
  const device = makeDevice();
  await saveRoster(device as never, roster());
  assert.equal(await loadRoster(device as never).then((value) => value.list().length), 2);
});

test('配了管理密钥后：未盖章 = 不认（trust 如实给出，交给调用方拒绝）', async () => {
  const device = makeDevice();
  const { port, publicHex } = makePort();
  await saveRoster(device as never, roster());
  await setManagementKey(device as never, publicHex);
  assert.equal(await getManagementKey(device as never), publicHex);

  const checked = await loadRosterChecked(device as never, { port, expectedManagementKey: publicHex });
  assert.equal(checked.trust, 'unstamped');
  assert.match(checked.message, /不认/);
});

test('盖章之后同一台机器读到 stamped-verified；换成别的管理密钥则不认', async () => {
  const device = makeDevice();
  const mine = makePort();
  const other = makePort();
  await saveStampedRoster(device as never, roster(), {
    port: mine.port,
    managementPrivateKey: mine.privateHex,
    managementPublicKey: mine.publicHex,
    at: NOW,
  });

  const mineCheck = await loadRosterChecked(device as never, { port: mine.port, expectedManagementKey: mine.publicHex });
  assert.equal(mineCheck.trust, 'stamped-verified');

  const otherCheck = await loadRosterChecked(device as never, { port: other.port, expectedManagementKey: other.publicHex });
  assert.equal(otherCheck.trust, 'key-mismatch');
  assert.equal(device.store.get(ROSTER_KEY)?.includes('"stamp"'), true, '落盘里应当带着章');
});
