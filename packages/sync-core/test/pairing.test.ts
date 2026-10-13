import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromBase64Url, toBase64Url, utf8 } from '../../oplog/src/bytes.ts';
import { messageAppend } from '../../oplog/src/op.ts';
import { HlcClock } from '../../oplog/src/hlc.ts';
import { packSegment, unpackSegment } from '../../oplog/src/segment.ts';
import {
  createAesGcmCipher,
  createDeviceSigner,
  createRosterVerifier,
  generateDeviceKeyPair,
  nodeDigest,
  nodeGzip,
  type DeviceKeyPair,
} from '../../oplog/src/node-adapters.ts';
import {
  createPairingInvite,
  decodePairingInvite,
  encodePairingInvite,
  PAIRING_SCHEME,
  pairFromInvite,
  profileKeyOf,
} from '../src/pairing.ts';
import { DeviceRosterList, parseRoster, serializeRoster } from '../src/roster.ts';

const NOW = 1_700_000_000_000;

interface Device {
  keys: DeviceKeyPair;
  profileKey: Uint8Array;
}

function makeDevice(deviceId: string, seed: number): Device {
  return { keys: generateDeviceKeyPair(deviceId), profileKey: new Uint8Array(32).fill(seed) };
}

test('配对二维码：编码 → 解码往返，主密钥与公钥原样恢复', () => {
  const device = makeDevice('device-a', 7);
  const invite = createPairingInvite({
    deviceId: 'device-a',
    name: '我的手机',
    publicKey: device.keys.publicKeyPem,
    profileKey: device.profileKey,
    now: NOW,
  });

  const uri = encodePairingInvite(invite);
  assert.ok(uri.startsWith(`${PAIRING_SCHEME}?v=1&p=`), '必须是可扫码的 URI');
  assert.equal(uri.includes('BEGIN PUBLIC KEY'), false, 'PEM 里的换行不应出现在 URI 里');

  const parsed = decodePairingInvite(uri, { now: NOW + 1000 });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.invite.deviceId, 'device-a');
  assert.equal(parsed.invite.name, '我的手机');
  assert.equal(parsed.invite.publicKey, device.keys.publicKeyPem);
  assert.deepEqual([...profileKeyOf(parsed.invite)], [...device.profileKey]);
});

test('过期的二维码必须被拒绝（配对是一次性的）', () => {
  const device = makeDevice('device-a', 7);
  const invite = createPairingInvite({
    deviceId: 'device-a',
    name: '我的手机',
    publicKey: device.keys.publicKeyPem,
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
    createPairingInvite({
      deviceId: 'device-a',
      name: '手机',
      publicKey: device.keys.publicKeyPem,
      profileKey: device.profileKey,
      now: NOW,
    }),
  );

  const notOurs = decodePairingInvite('https://example.com/pair', { now: NOW });
  assert.equal(notOurs.ok, false);

  const badVersion = decodePairingInvite(good.replace('v=1', 'v=9'), { now: NOW });
  assert.equal(badVersion.ok, false);
  if (!badVersion.ok) assert.match(badVersion.error, /版本/);

  const noPayload = decodePairingInvite(`${PAIRING_SCHEME}?v=1`, { now: NOW });
  assert.equal(noPayload.ok, false);

  const garbage = decodePairingInvite(`${PAIRING_SCHEME}?v=1&p=@@@not-base64@@@`, { now: NOW });
  assert.equal(garbage.ok, false);

  // 主密钥长度不对：必须拒绝，否则配出一把错的加密密钥
  const payload = { ...JSON.parse(new TextDecoder().decode(fromBase64Url(good.split('p=')[1] as string))) } as Record<string, unknown>;
  payload.profileKey = toBase64Url(utf8('short'));
  const shortKey = decodePairingInvite(`${PAIRING_SCHEME}?v=1&p=${toBase64Url(utf8(JSON.stringify(payload)))}`, { now: NOW });
  assert.equal(shortKey.ok, false);
  if (!shortKey.ok) assert.match(shortKey.error, /主密钥长度/);

  // 公钥不是 PEM
  payload.profileKey = toBase64Url(device.profileKey);
  payload.publicKey = 'not-a-pem';
  const badPem = decodePairingInvite(`${PAIRING_SCHEME}?v=1&p=${toBase64Url(utf8(JSON.stringify(payload)))}`, { now: NOW });
  assert.equal(badPem.ok, false);
  if (!badPem.ok) assert.match(badPem.error, /公钥/);
});

test('配对是信任根：配对前拒绝对方签名，配对后接受', async () => {
  const a = makeDevice('device-a', 7);
  const b = makeDevice('device-b', 9);

  // A 先只知道自己
  const roster = new DeviceRosterList([{ deviceId: 'device-a', publicKey: a.keys.publicKeyPem, addedAt: NOW }]);

  const segment = await packSegment({
    ops: [
      messageAppend(
        { deviceId: 'device-b', clock: new HlcClock({ now: () => NOW }) },
        { sessionId: 'S1', messageId: 'B1', author: 'character', content: '来自尚未配对的设备' },
      ),
    ],
    deviceId: 'device-b',
    seq: 1,
    blindSessionId: 'b'.repeat(32),
    ports: {
      digest: nodeDigest,
      compressor: nodeGzip,
      signer: createDeviceSigner(b.keys),
      cipher: createAesGcmCipher({ key: b.profileKey }),
    },
    encrypt: true,
  });

  // 未配对：名单里没有 B 的公钥 → 拒绝
  await assert.rejects(
    unpackSegment(segment.bytes, {
      ports: {
        digest: nodeDigest,
        compressor: nodeGzip,
        verifier: createRosterVerifier(roster.toVerifierMap()),
        cipher: createAesGcmCipher({ key: a.profileKey }),
      },
      fileName: segment.name,
    }),
    /signature|签名/,
  );

  // B 出示二维码，A 扫码配对
  const invite = createPairingInvite({
    deviceId: 'device-b',
    name: '我的平板',
    publicKey: b.keys.publicKeyPem,
    profileKey: b.profileKey,
    now: NOW,
  });
  const parsed = decodePairingInvite(encodePairingInvite(invite), { now: NOW });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  pairFromInvite(roster, parsed.invite, { at: NOW });
  assert.deepEqual(roster.activeIds(), ['device-a', 'device-b']);

  // 配对后：验签通过，且用二维码里的主密钥可以解密
  const unpacked = await unpackSegment(segment.bytes, {
    ports: {
      digest: nodeDigest,
      compressor: nodeGzip,
      verifier: createRosterVerifier(roster.toVerifierMap()),
      cipher: createAesGcmCipher({ key: profileKeyOf(parsed.invite) }),
    },
    fileName: segment.name,
  });
  assert.equal(unpacked.ops.length, 1);
  assert.equal((unpacked.ops[0]?.payload as { content: string }).content, '来自尚未配对的设备');
});

test('名单可落盘并恢复（含退役状态），缺公钥即拒绝', () => {
  const roster = new DeviceRosterList([
    { deviceId: 'a', publicKey: 'pem-a', addedAt: 1, name: '手机' },
    { deviceId: 'b', publicKey: 'pem-b', addedAt: 2 },
  ]);
  roster.revoke('b', 3);

  const restored = parseRoster(serializeRoster(roster));
  assert.deepEqual(restored.activeIds(), ['a']);
  assert.equal(restored.get('b')?.revokedAt, 3);
  assert.equal(restored.toVerifierMap().has('b'), false, '退役设备不得用于验签');

  assert.throws(() => parseRoster('{"v":2,"devices":[]}'), /版本/);
  assert.throws(() => parseRoster('{"v":1,"devices":[{"deviceId":"c","addedAt":1}]}'), /公钥/);
  assert.throws(() => parseRoster('not json'), /解析失败/);
});
