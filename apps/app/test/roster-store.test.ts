import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeDevice, loadRoster, mergeRoster, saveRoster } from '../src/data/sync/roster-store.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import type { DeviceStore } from '../src/data/op-ports.ts';

/**
 * 设备名单的本地语义。
 *
 * 为什么这些规则要测：名单是 GC 的唯一判据（"所有活跃设备都已并入"），
 * 而且**吊销必须跨重启保持**——之前名单每次同步临时重建，吊销重启就忘，
 * 后果是该删的段不敢删、该保留的段反而可能被判定为可回收。
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

test('名单：远端发现的设备被登记，本机永远在名单且不被吊销', async () => {
  const device = deviceStore();
  const empty = await loadRoster(device);

  const { roster, added } = mergeRoster(empty, [{ deviceId: 'peer-1' }], { selfId: 'me', now: 100 });
  assert.deepEqual(added, ['peer-1']);
  const ids = roster.list().map((record) => record.deviceId).sort();
  assert.deepEqual(ids, ['me', 'peer-1']);

  const described = roster.list().map((record) => describeDevice(record, 'me'));
  assert.equal(described.find((item) => item.deviceId === 'me')?.self, true);
  assert.equal(described.find((item) => item.deviceId === 'me')?.name, '本机');
  assert.equal(described.find((item) => item.deviceId === 'peer-1')?.self, false);
});

test('名单：吊销写入后必须跨重启保持（同一台设备再被发现也不复活）', async () => {
  const device = deviceStore();
  const first = mergeRoster(await loadRoster(device), [{ deviceId: 'peer-1' }], { selfId: 'me', now: 100 }).roster;
  assert.equal(first.revoke('peer-1', 200), true);
  await saveRoster(device, first);

  // "重启"：重新读名单，并且这次同步又在远端看到了 peer-1
  const reloaded = await loadRoster(device);
  const reloadedPeer = reloaded.get('peer-1');
  assert.notEqual(reloadedPeer, undefined, '重开后 peer-1 还在名单里');
  assert.equal(describeDevice(reloadedPeer!, 'me').revoked, true, '吊销状态要持久化');
  const { roster } = mergeRoster(reloaded, [{ deviceId: 'peer-1' }], { selfId: 'me', now: 300 });
  const peer = roster.get('peer-1');
  assert.notEqual(peer?.revokedAt, undefined, '再次发现不能把已吊销的设备复活');
  assert.equal(roster.activeIds().includes('peer-1'), false);
});

test('名单：本机不会被自己吊销（否则下次同步会把自己排除）', async () => {
  const device = deviceStore();
  const roster = mergeRoster(await loadRoster(device), [], { selfId: 'me', now: 100 }).roster;
  assert.equal(roster.revoke('me', 200), true);
  await saveRoster(device, roster);

  const { roster: merged } = mergeRoster(await loadRoster(device), [], { selfId: 'me', now: 300 });
  assert.equal(merged.get('me')?.revokedAt, undefined, '本机始终有效');
});

test('名单：坏数据不阻塞同步（当作还没有名单，重新发现）', async () => {
  const device = deviceStore();
  await device.set('sync.roster.v1', '{不是 JSON');
  const roster = await loadRoster(device);
  assert.equal(roster.list().length, 0);

  await device.set('sync.roster.v1', JSON.stringify({ v: 2, devices: [] }));
  assert.equal((await loadRoster(device)).list().length, 0, '版本不认识就当空名单');
});

test('名单：设备显示名能用 id 后缀兜底，不暴露完整长 id 之外的东西', () => {
  const described = describeDevice({ deviceId: '01JABCDEFGH', publicKey: '', addedAt: 1 }, 'me');
  assert.equal(described.name, '设备 EFGH');
  assert.equal(described.revoked, false);
});
