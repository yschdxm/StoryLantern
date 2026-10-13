import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocaleService,
  detectLocale,
  interpolate,
  localeChain,
  normalizeLocale,
} from '../src/index.ts';

const CHAT_ZH = {
  'chat.send': '发送',
  'chat.delete': '删除 {{count}} 条消息',
  'chat.delete.one': '删除 {{count}} 条消息',
  'chat.delete.other': '删除 {{count}} 条消息',
  'chat.message': '{{name}} 说：{{text}}',
};
const CHAT_EN = {
  'chat.send': 'Send',
  'chat.delete.one': 'Delete {{count}} message',
  'chat.delete.other': 'Delete {{count}} messages',
  'chat.message': '{{name}} says: {{text}}',
};

function service(locale = 'zh-CN') {
  const svc = createLocaleService({ locale, fallbacks: ['zh-CN', 'zh', 'en'] });
  svc.register({ namespace: 'chat', locale: 'zh-CN', messages: CHAT_ZH });
  svc.register({ namespace: 'chat', locale: 'en', messages: CHAT_EN });
  return svc;
}

test('语言标签归一化：丢掉 script，保留地区；语言级可回退', () => {
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh_hant_TW'), 'zh-TW');
  assert.equal(normalizeLocale('EN-us'), 'en-US');
  assert.equal(normalizeLocale('zh'), 'zh');
  assert.equal(normalizeLocale(''), '');

  assert.deepEqual(localeChain('zh-Hans-CN', ['en']), ['zh-CN', 'zh', 'en']);
  assert.deepEqual(localeChain('fr-FR', ['zh-CN', 'zh', 'en']), ['fr-FR', 'fr', 'zh-CN', 'zh', 'en']);
});

test('插值：{{name}} 形式；缺参数时保留占位符（漏配要一眼可见）', () => {
  assert.equal(interpolate('你好 {{name}}', { name: '星野' }), '你好 星野');
  assert.equal(interpolate('你好 {{name}}'), '你好 {{name}}');
  assert.equal(interpolate('没有占位符', { name: 'x' }), '没有占位符');
  assert.equal(interpolate('{{a}}-{{b}}', { a: 1, b: 2 }), '1-2');
});

test('回退链：请求 zh-CN 命中中文，请求未知语言退到回退列表', () => {
  const svc = service('zh-CN');
  assert.equal(svc.t('chat.send', undefined, { namespace: 'chat' }), '发送');

  assert.equal(svc.setLocale('fr-FR'), true);
  assert.equal(svc.locale, 'fr-FR');
  // fr-FR → fr → zh-CN（回退列表第一个）→ 命中中文
  assert.equal(svc.t('chat.send', undefined, { namespace: 'chat' }), '发送');

  assert.equal(svc.setLocale('en'), true);
  assert.equal(svc.t('chat.send', undefined, { namespace: 'chat' }), 'Send');
  assert.equal(svc.setLocale('en'), false, '切到同一语言应返回 false');
});

test('复数：英文分 one/other，中文只有 other（规则来自 Intl.PluralRules）', () => {
  const svc = service('en');
  assert.equal(svc.t('chat.delete', { count: 1 }, { namespace: 'chat' }), 'Delete 1 message');
  assert.equal(svc.t('chat.delete', { count: 5 }, { namespace: 'chat' }), 'Delete 5 messages');

  svc.setLocale('zh-CN');
  assert.equal(svc.t('chat.delete', { count: 1 }, { namespace: 'chat' }), '删除 1 条消息');
  assert.equal(svc.t('chat.delete', { count: 9 }, { namespace: 'chat' }), '删除 9 条消息');
});

test('没有 namespace 时按已注册语言包搜索；同 key 冲突以注册顺序取先者', () => {
  const svc = createLocaleService({ locale: 'zh-CN' });
  svc.register({ namespace: 'b', locale: 'zh-CN', messages: { 'only.b': '来自 b' } });
  svc.register({ namespace: 'a', locale: 'zh-CN', messages: { 'only.a': '来自 a' } });
  assert.equal(svc.t('only.a'), '来自 a');
  assert.equal(svc.t('only.b'), '来自 b');
});

test('缺翻译：返回 key 本身、记入 missing()，strict 模式则抛错', () => {
  const svc = service('zh-CN');
  assert.equal(svc.t('chat.nope', undefined, { namespace: 'chat' }), 'chat.nope');
  assert.deepEqual(svc.missing(), [{ namespace: 'chat', key: 'chat.nope', locale: 'zh-CN' }]);
  svc.clearMissing();
  assert.deepEqual(svc.missing(), []);

  const strict = createLocaleService({ locale: 'zh-CN', strict: true });
  strict.register({ namespace: 'chat', locale: 'zh-CN', messages: CHAT_ZH });
  assert.throws(() => strict.t('chat.nope', undefined, { namespace: 'chat' }), /缺少翻译/);
});

test('注册即 effect：disposer 撤销语言包，重复注册同名冲突即报错', () => {
  const svc = createLocaleService({ locale: 'zh-CN' });
  const off = svc.register({ namespace: 'chat', locale: 'zh-CN', messages: CHAT_ZH });
  assert.equal(svc.supports('zh-CN'), true);
  assert.equal(svc.t('chat.send', undefined, { namespace: 'chat' }), '发送');

  assert.throws(() => svc.register({ namespace: 'chat', locale: 'zh-CN', messages: {} }), /冲突/);
  off();
  assert.equal(svc.supports('zh-CN'), false);
  assert.equal(svc.locales().length, 0);

  // 撤销后可以重新注册
  svc.register({ namespace: 'chat', locale: 'zh-CN', messages: CHAT_ZH });
  assert.equal(svc.t('chat.send', undefined, { namespace: 'chat' }), '发送');
});

test('注册参数校验：空 namespace / 空 locale 明确报错', () => {
  const svc = createLocaleService();
  assert.throws(() => svc.register({ namespace: '  ', locale: 'zh-CN', messages: {} }), /namespace/);
  assert.throws(() => svc.register({ namespace: 'x', locale: '', messages: {} }), /locale/);
});

test('从系统偏好里挑语言：精确匹配优先，其次同语言，最后空串', () => {
  assert.equal(detectLocale(['zh-Hans-CN', 'en-US'], { supported: ['zh-CN', 'en'] }), 'zh-CN');
  assert.equal(detectLocale(['en-GB', 'zh-CN'], { supported: ['zh-CN', 'en'] }), 'en');
  assert.equal(detectLocale(['de-DE'], { supported: ['zh-CN', 'en'] }), '');
  assert.equal(detectLocale(['ja-JP']), 'ja-JP', '没有 supported 列表时原样归一化');
});

test('supports：地区不同但语言相同也算支持（zh-TW 命中 zh-CN 的语言包）', () => {
  const svc = service('zh-CN');
  assert.equal(svc.supports('zh-TW'), true);
  assert.equal(svc.supports('zh'), true);
  assert.equal(svc.supports('fr'), false);
});
