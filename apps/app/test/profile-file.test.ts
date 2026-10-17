import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportProfile,
  parseProfile,
  PROFILE_FORMAT,
  PROFILE_VERSION,
  ProfileError,
} from '../src/data/profile-file.ts';

/** 可分享配置档：**密钥永不进文件**是这条功能的核心约束，测试先钉它。 */

test('导出配置档：剔除所有看起来像密钥的键，并在结果里报告键名（不含值）', () => {
  const { profile, removedKeys } = exportProfile({
    settings: {
      'model.base_url': 'https://api.deepseek.com/v1',
      'model.name': 'deepseek-flash',
      'model.api_key': 'sk-should-never-appear',
      'sync.app_specific_password': 'hunter2',
      'sync.webdav.token': 't',
      'model.temperature': '0.9',
    },
    now: new Date('2026-10-17T00:00:00.000Z'),
  });
  assert.deepEqual(removedKeys.sort(), ['model.api_key', 'sync.app_specific_password', 'sync.webdav.token']);
  assert.equal(profile.format, PROFILE_FORMAT);
  assert.equal(profile.version, PROFILE_VERSION);
  assert.equal(profile.createdAt, '2026-10-17T00:00:00.000Z');
  assert.deepEqual(profile.settings, {
    'model.base_url': 'https://api.deepseek.com/v1',
    'model.name': 'deepseek-flash',
    'model.temperature': '0.9',
  });
  // 序列化后的文件里绝不能出现密钥值
  assert.ok(!JSON.stringify(profile).includes('sk-should-never-appear'));
  assert.ok(!JSON.stringify(profile).includes('hunter2'));
});

test('导入配置档：往返一致，旧版本给 note，带密钥字段被拒绝并报数', () => {
  const { profile } = exportProfile({ settings: { 'model.name': 'deepseek-flash' }, patch: 'rows:\n  - set: {id: sync-s3, disabled: true}\n' });
  const parsed = parseProfile(JSON.parse(JSON.stringify(profile)));
  assert.deepEqual(parsed.profile.settings, profile.settings);
  assert.equal(parsed.profile.patch, profile.patch);
  assert.deepEqual(parsed.notes, []);

  const withSecrets = parseProfile({
    format: PROFILE_FORMAT,
    version: 1,
    settings: { 'model.name': 'x', 'model.api_key': 'sk-bad' },
  });
  assert.deepEqual(withSecrets.removedKeys, ['model.api_key']);
  assert.equal(withSecrets.profile.settings['model.api_key'], undefined);
  assert.equal(withSecrets.notes.length, 1);

  const older = parseProfile({ format: PROFILE_FORMAT, version: 0, settings: {} });
  assert.ok(older.notes.some((note) => note.includes('较旧')));
});

test('导入配置档：格式不对 / 版本比我们新 / 结构坏了都要明确报错，而不是尽力解析', () => {
  const cases: { input: unknown; code: string }[] = [
    { input: null, code: 'bad-profile' },
    { input: [], code: 'bad-profile' },
    { input: { format: 'something-else', version: 1, settings: {} }, code: 'unknown-format' },
    { input: { format: PROFILE_FORMAT, version: 99, settings: {} }, code: 'newer-version' },
    { input: { format: PROFILE_FORMAT, version: 1, settings: 'nope' }, code: 'bad-settings' },
    { input: { format: PROFILE_FORMAT, version: 1, settings: { a: 1 } }, code: 'bad-setting' },
    { input: { format: PROFILE_FORMAT, version: 1, settings: {}, patch: 42 }, code: 'bad-patch' },
  ];
  for (const { input, code } of cases) {
    assert.throws(
      () => parseProfile(input),
      (error: unknown) => error instanceof ProfileError && error.code === code,
      `输入 ${JSON.stringify(input)} 应当报 ${code}`,
    );
  }
});
