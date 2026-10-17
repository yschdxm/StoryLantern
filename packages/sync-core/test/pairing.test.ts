import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromBase64Url, toBase64Url, utf8 } from '../../oplog/src/bytes.ts';
import {
  createPairingInvite,
  decodePairingInvite,
  encodePairingInvite,
  PAIRING_SCHEME,
  pairFromInvite,
  profileKeyOf,
} from '../src/pairing.ts';
import { DeviceRosterList } from '../src/roster.ts';

const NOW = 1_700_000_000_000;

function makeDevice(deviceId: string, seed: number): { profileKey: Uint8Array } {
  return { profileKey: new Uint8Array(32).fill(seed) };
}

test('配对二维码：编码 → 解码往返，主密钥原样恢复', () => {
  const device = makeDevice('device-a', 7);
  const invite = createPairingInvite({ deviceId: 'device-a', name: '我的手机', profileKey: device.profileKey, now: NOW });

  const uri = encodePairingInvite(invite);
  assert.ok(uri.startsWith(`${PAIRING_SCHEME}?v=1&p=`), '必须是可扫码的 URI');

  const parsed = decodePairingInvite(uri, { now: NOW + 1000 });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.invite.deviceId, 'device-a');
  assert.equal(parsed.invite.name, '我的手机');
  assert.deepEqual([...profileKeyOf(parsed.invite)], [...device.profileKey]);
});

test('过期的二维码必须被拒绝（配对是一次性的）', () => {
  const device = makeDevice('device-a', 7);
  const invite = createPairingInvite({
    deviceId: 'device-a',
    name: '我的手机',
    profileKey: device.profileKey,
    now: NOW,
    ttlMs: 60_000,
  });
  const uri = encodePairingInvite(invite);

  assert.equal(decodePairingInvite(uri, { now: NOW + 30_000 }).ok, true);
  const expired = decodePairingInvite(uri, { now: NOW + 61_000 });
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.match(expired.error, /已过期/);
});

test('畸形输入必须明确失败，不能"看起来能用"', () => {
  const device = makeDevice('device-a', 7);
  const good = encodePairingInvite(
    createPairingInvite({ deviceId: 'device-a', name: '手机', profileKey: device.profileKey, now: NOW }),
  );

  assert.equal(decodePairingInvite('https://example.com/pair', { now: NOW }).ok, false);

  const badVersion = decodePairingInvite(good.replace('v=1', 'v=9'), { now: NOW });
  assert.equal(badVersion.ok, false);
  if (!badVersion.ok) assert.match(badVersion.error, /版本/);

  assert.equal(decodePairingInvite(`${PAIRING_SCHEME}?v=1`, { now: NOW }).ok, false);
  assert.equal(decodePairingInvite(`${PAIRING_SCHEME}?v=1&p=@@@not-base64@@@`, { now: NOW }).ok, false);

  // 主密钥长度不对：必须拒绝，否则配出一把错的加密密钥
  const payload = { ...JSON.parse(new TextDecoder().decode(fromBase64Url(good.split('p=')[1] as string))) } as Record<string, unknown>;
  payload.profileKey = toBase64Url(utf8('short'));
  const shortKey = decodePairingInvite(`${PAIRING_SCHEME}?v=1&p=${toBase64Url(utf8(JSON.stringify(payload)))}`, { now: NOW });
  assert.equal(shortKey.ok, false);
  if (!shortKey.ok) assert.match(shortKey.error, /主密钥长度/);
});

test('配对把对方登记进名单（只记 deviceId/名称/加入时间）', () => {
  const invite = createPairingInvite({ deviceId: 'device-b', name: '我的平板', profileKey: new Uint8Array(32).fill(9), now: NOW });
  const parsed = decodePairingInvite(encodePairingInvite(invite), { now: NOW });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const roster = new DeviceRosterList();
  pairFromInvite(roster, parsed.invite, { at: NOW });
  assert.deepEqual(roster.activeIds(), ['device-b']);
  assert.equal(roster.get('device-b')?.name, '我的平板');
});
