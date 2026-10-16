import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksumOf, createJoinLink, decodeJoinLink, joinLinkWrites } from '../src/data/sync/join-link.ts';
import type { SyncConfig } from '../src/data/sync/app-sync.ts';

/**
 * 配对链接：一段文本把"新设备开始同步所需的一切"传过去。
 *
 * 为什么值得单测：这段文本里带着**同步口令**（端到端加密的根），而它又要在屏幕上抄/贴 ——
 * 抄错一个字符最坏的结果是"新设备配置了个看起来对、其实连不上的远端"，或者更糟：
 * 用了半截口令却以为配好了。所以：校验和不符必须拒绝、过期必须拒绝、缺关键字段必须拒绝。
 */

function config(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    kind: 'webdav',
    url: 'https://nas.local:5006/storylantern/',
    username: 'me',
    password: 'pw',
    folder: '',
    secret: 'correct horse battery staple',
    s3Endpoint: '',
    s3Bucket: '',
    s3Region: '',
    s3AccessKeyId: '',
    s3SecretAccessKey: '',
    ...overrides,
  };
}

test('WebDAV：往返一致（地址/用户名/密码/口令都带过去）', () => {
  const now = 1_700_000_000_000;
  const { link, expiresAt } = createJoinLink({ config: config(), now, nonce: 'fixed' });
  assert.equal(expiresAt, now + 15 * 60 * 1000, '默认有效期 15 分钟');

  const parsed = decodeJoinLink(link, { now });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.payload.kind, 'webdav');
  assert.equal(parsed.payload.url, 'https://nas.local:5006/storylantern/');
  assert.equal(parsed.payload.username, 'me');
  assert.equal(parsed.payload.password, 'pw');
  assert.equal(parsed.payload.secret, 'correct horse battery staple');
});

test('S3：端点/桶/区域/Access Key 与 Secret 都带过去', () => {
  const now = 1_700_000_000_000;
  const { link } = createJoinLink({
    config: config({
      kind: 's3',
      s3Endpoint: 'http://127.0.0.1:9000',
      s3Bucket: 'storylantern',
      s3Region: 'us-east-1',
      s3AccessKeyId: 'minioadmin',
      s3SecretAccessKey: 'minioadmin',
    }),
    now,
  });
  const parsed = decodeJoinLink(link, { now });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.payload.bucket, 'storylantern');
  assert.equal(parsed.payload.s3SecretAccessKey, 'minioadmin');
});

test('摊平：非机密进设置、机密单独给出（机密不能进设置，否则会被掩码覆盖）', () => {
  const now = 1_700_000_000_000;
  const { link } = createJoinLink({
    config: config({
      kind: 's3',
      s3Endpoint: 'http://127.0.0.1:9000',
      s3Bucket: 'storylantern',
      s3Region: 'us-east-1',
      s3AccessKeyId: 'minioadmin',
      s3SecretAccessKey: 'sk',
    }),
    now,
  });
  const parsed = decodeJoinLink(link, { now });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const writes = joinLinkWrites(parsed.payload);
  assert.equal(writes.settings['sync.kind'], 's3');
  assert.equal(writes.settings['sync.s3.bucket'], 'storylantern');
  assert.equal(writes.settings['sync.s3.endpoint'], 'http://127.0.0.1:9000');
  assert.equal(writes.secrets.secret, 'correct horse battery staple');
  assert.equal(writes.secrets.s3SecretAccessKey, 'sk');
  assert.equal('secret' in writes.settings, false, '口令绝不能出现在要写进设置的那一份里');
  assert.equal('sync.s3.secretAccessKey' in writes.settings, false, 'S3 密钥同理：它是机密，不进设置');
});

test('过期必须拒绝（并说清"让对方重新生成"）', () => {
  const now = 1_700_000_000_000;
  const { link } = createJoinLink({ config: config(), now, ttlMs: 1000 });
  const parsed = decodeJoinLink(link, { now: now + 2000 });
  assert.deepEqual(parsed, { ok: false, error: '配对链接已过期，请让对方重新生成' });
});

test('抄错/截断必须拒绝（校验和就是为了这个）', () => {
  const now = 1_700_000_000_000;
  const { link } = createJoinLink({ config: config(), now });
  const broken = link.slice(0, link.length - 3) + 'zzz';
  const parsed = decodeJoinLink(broken, { now });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /校验和不符/);
});

test('不是我们的链接、版本不对、缺口令：都要明确失败', () => {
  assert.match((decodeJoinLink('https://example.com/') as { error: string }).error, /不是 Story Lantern 配对链接/);
  assert.match((decodeJoinLink('storylantern://join?v=2&c=x&p=y') as { error: string }).error, /不支持的配对版本/);

  const body = btoa(JSON.stringify({ v: 1, kind: 'webdav', url: 'x', expiresAt: Date.now() + 1000 }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const parsed = decodeJoinLink(`storylantern://join?v=1&c=${checksumOf(body)}&p=${body}`);
  assert.deepEqual(parsed, { ok: false, error: '配对内容里没有同步口令' });
});

test('生成时就拒绝"半截配置"：没选方式 / 没口令 / 没远端', () => {
  assert.throws(() => createJoinLink({ config: config({ kind: 'off' }) }), /还没有选同步方式/);
  assert.throws(() => createJoinLink({ config: config({ secret: '  ' }) }), /同步口令/);
  assert.throws(() => createJoinLink({ config: config({ url: '' }) }), /远端地址/);
  assert.throws(() => createJoinLink({ config: config({ kind: 's3', s3Endpoint: '' }) }), /S3 端点或桶名/);
});
