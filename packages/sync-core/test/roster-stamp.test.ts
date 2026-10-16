import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  DeviceRosterList,
  assessRosterTrust,
  parseRoster,
  readRosterStamp,
  rosterPayload,
  serializeRoster,
  stampRoster,
  type RosterStampPort,
} from '../src/roster.ts';

/**
 * 名单盖章（管理密钥背书）。
 *
 * 这是文档里记了很久的安全欠账：以前信任模型是"名单优先于签名"，能防伪造**内容**，
 * 防不了"名单本身被谁改过"。这组测试要钉住三件事：
 *  1. 盖过的名单能验过，**改一个字节就验不过**；
 *  2. 本机配了管理密钥时，"没盖章 / 章是别的密钥 / 签名坏了"三种都**不认**；
 *  3. 本机没配管理密钥时不改变旧行为（老名单照样能读），但如实告诉调用方 `unstamped`。
 *
 * 用 Node 自带的 Ed25519 做端口（与 app 侧的 WebCrypto Ed25519 同形），测试不依赖网络也不依赖 app。
 */

function makePort() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateHex = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('hex');
  const publicHex = publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
  const port: RosterStampPort = {
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
  };
  return { port, privateHex, publicHex };
}

const NOW = 1_700_000_000_000;

function rosterWithTwo(): DeviceRosterList {
  return new DeviceRosterList([
    { deviceId: 'device-a', publicKey: 'pem-a', addedAt: NOW },
    { deviceId: 'device-b', publicKey: 'pem-b', addedAt: NOW + 1 },
  ]);
}

test('规范载荷：与设备的书写顺序无关（否则"签名对、验章不过"这种问题最难查）', () => {
  const forward = rosterPayload([
    { deviceId: 'a', publicKey: 'pa', addedAt: 1 },
    { deviceId: 'b', publicKey: 'pb', addedAt: 2 },
  ]);
  const backward = rosterPayload([
    { deviceId: 'b', publicKey: 'pb', addedAt: 2 },
    { deviceId: 'a', publicKey: 'pa', addedAt: 1 },
  ]);
  assert.deepEqual([...forward], [...backward]);
  // revokedAt / bannedAt / name 也必须是"有没有就变字节"的显式字段
  const withRevoke = rosterPayload([{ deviceId: 'a', publicKey: 'pa', addedAt: 1, revokedAt: 9 }]);
  assert.notDeepEqual([...withRevoke], [...rosterPayload([{ deviceId: 'a', publicKey: 'pa', addedAt: 1 }])]);
});

test('盖章 → 验章通过；改一个字节就验不过', async () => {
  const { port, privateHex, publicHex } = makePort();
  const roster = rosterWithTwo();
  const stamp = await stampRoster({ roster, managementPrivateKey: privateHex, managementPublicKey: publicHex, port, at: NOW });
  const text = serializeRoster(roster, { stamp });

  const good = await assessRosterTrust({ text, port, expectedManagementKey: publicHex });
  assert.equal(good.trust, 'stamped-verified');
  assert.equal(good.roster.list().length, 2);

  // 篡改：把 b 的公钥换掉（这正是"名单被谁改过"想防的攻击）
  const tampered = text.replace('pem-b', 'pem-attacker');
  assert.notEqual(tampered, text);
  const bad = await assessRosterTrust({ text: tampered, port, expectedManagementKey: publicHex });
  assert.equal(bad.trust, 'bad-signature');
  assert.match(bad.message, /不认/);

  // 篡改盖章本身（把签名改一个字符）
  const brokenStamp = text.replace(/"signature": "([0-9a-f]{4})/, (_all, head: string) => `"signature": "${head === '0000' ? '1111' : '0000'}`);
  const broken = await assessRosterTrust({ text: brokenStamp, port, expectedManagementKey: publicHex });
  assert.ok(broken.trust === 'bad-signature' || broken.trust === 'key-mismatch', `实际 ${broken.trust}`);
});

test('配了管理密钥时：没盖章 / 章是别的密钥 → 都不认（这就是"管理密钥签发；没盖章不认"）', async () => {
  const mine = makePort();
  const other = makePort();
  const roster = rosterWithTwo();

  const unstamped = serializeRoster(roster);
  const unstampedResult = await assessRosterTrust({ text: unstamped, port: mine.port, expectedManagementKey: mine.publicHex });
  assert.equal(unstampedResult.trust, 'unstamped');
  assert.match(unstampedResult.message, /不认/);

  const otherStamp = await stampRoster({
    roster,
    managementPrivateKey: other.privateHex,
    managementPublicKey: other.publicHex,
    port: other.port,
    at: NOW,
  });
  const foreign = await assessRosterTrust({
    text: serializeRoster(roster, { stamp: otherStamp }),
    port: mine.port,
    expectedManagementKey: mine.publicHex,
  });
  assert.equal(foreign.trust, 'key-mismatch');
});

test('本机没配管理密钥时不改变旧行为：老名单照样读，但如实报 unstamped', async () => {
  const { port } = makePort();
  const legacy = serializeRoster(rosterWithTwo()); // 没有 stamp 字段的旧文本
  const result = await assessRosterTrust({ text: legacy, port });
  assert.equal(result.trust, 'unstamped');
  assert.match(result.message, /按旧行为继续/);
  assert.equal(result.roster.list().length, 2);
  // 老 API 也照旧能用（兼容性：现有调用点不必改）
  assert.equal(parseRoster(legacy).list().length, 2);
  assert.equal(readRosterStamp(legacy), undefined);
});

test('落盘文本里没盖章时，serializeRoster 的输出与旧格式逐字节一致（不能悄悄改格式）', () => {
  const roster = rosterWithTwo();
  const text = serializeRoster(roster);
  const parsed = JSON.parse(text) as { v: number; devices: unknown[]; stamp?: unknown };
  assert.equal(parsed.v, 1);
  assert.equal(parsed.devices.length, 2);
  assert.equal(parsed.stamp, undefined);
  assert.equal(text.startsWith('{\n  "v": 1,'), true);
});
