import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppLocaleService, translatorOf } from '../src/i18n/locale.ts';
import { APP_LOCALES, APP_MESSAGES } from '../src/i18n/messages.ts';

/**
 * 文案体检：两种语言必须有**完全相同的 key 集合**。
 *
 * 缺一条 key 的后果不是报错，而是在某个语言下突然冒出中文或 key 本身——
 * 这种问题只有用户切到那个语言才会发现，所以放进测试里。
 */
test('i18n：中英文 key 集合完全一致', () => {
  const zh = new Set(Object.keys(APP_MESSAGES['zh-CN'] ?? {}));
  const en = new Set(Object.keys(APP_MESSAGES['en'] ?? {}));

  const missingInEn = [...zh].filter((key) => !en.has(key));
  const missingInZh = [...en].filter((key) => !zh.has(key));

  assert.deepEqual(missingInEn, [], '英文缺这些 key');
  assert.deepEqual(missingInZh, [], '中文缺这些 key');
  assert.ok(zh.size > 60, `目录太小（${zh.size} 条），可能漏了界面文案`);
});

test('i18n：插值占位符两种语言一一对应', () => {
  const placeholders = (text: string): string[] =>
    [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '').sort();

  for (const key of Object.keys(APP_MESSAGES['zh-CN'] ?? {})) {
    const zh = APP_MESSAGES['zh-CN']?.[key] ?? '';
    const en = APP_MESSAGES['en']?.[key] ?? '';
    assert.deepEqual(placeholders(en), placeholders(zh), `${key} 的占位符不一致`);
  }
});

test('i18n：切语言后取到对应语言，缺 key 不崩', () => {
  const service = createAppLocaleService('zh-CN');
  const t = translatorOf(service);

  assert.equal(t('tab.sessions'), '会话');
  assert.equal(service.setLocale('en'), true);
  assert.equal(t('tab.sessions'), 'Chats');
  assert.equal(
    t('sessions.delete.message', { title: 'Hoshino', count: 3 }),
    '“Hoshino” and its 3 messages will be deleted. This cannot be undone.',
  );

  assert.equal(t('nope.not.a.key'), 'nope.not.a.key', '缺 key 返回 key 本身，不抛错');
  assert.deepEqual(service.locales().sort(), [...APP_LOCALES].sort());
});

test('i18n：未知语言回退到默认语言而不是空白', () => {
  const service = createAppLocaleService('de-DE');
  const t = translatorOf(service);
  // de-DE 不在目录里，回退链会走到 zh-CN
  assert.equal(t('tab.characters'), '角色');
});

test('i18n：计数走 key.one / key.other 复数形态（英文不再出现 "1 characters"）', () => {
  const service = createAppLocaleService('en');
  const t = translatorOf(service);

  assert.equal(t('count.characters', { count: 1 }), '1 character');
  assert.equal(t('count.characters', { count: 3 }), '3 characters');
  assert.equal(t('count.sessions', { count: 1 }), '1 chat');
  assert.equal(t('import.action', { count: 1 }), 'Import 1 item');
  assert.equal(t('import.action', { count: 4 }), 'Import 4 items');
  assert.equal(
    t('sessions.delete.message', { title: 'X', count: 1 }),
    '“X” and its 1 message will be deleted. This cannot be undone.',
  );

  // 中文两种数量都读得通，不会掉到 key 本身
  service.setLocale('zh-CN');
  assert.equal(t('count.characters', { count: 1 }), '1 个角色');
  assert.equal(t('count.characters', { count: 9 }), '9 个角色');
});
