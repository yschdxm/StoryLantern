import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLocale, filterSettings, rowIdOf, type SettingsIndexEntry } from '../src/settings/settings-index.ts';

/**
 * 设置首页搜索的纯逻辑：匹配行标题 / 当前值 / 关键词，空查询不改变顺序。
 * 组件只负责渲染，这里把"搜得到什么"钉死。
 */
const ENTRIES: SettingsIndexEntry[] = [
  { id: 'model.chat', section: 'model', label: '聊天模型', value: 'deepseek-flash', keywords: '模型 密钥 openai api key' },
  { id: 'sync.kind', section: 'sync', label: '同步方式', value: 'WebDAV', keywords: '同步 设备 webdav' },
  { id: 'data.local', section: 'data', label: '本地数据', value: '12 个会话', keywords: '数据 备份' },
];

test('设置搜索：空查询返回全部且顺序不变', () => {
  assert.deepEqual(filterSettings(ENTRIES, '').map((item) => item.id), ['model.chat', 'sync.kind', 'data.local']);
  assert.deepEqual(filterSettings(ENTRIES, '   ').map((item) => item.id), ['model.chat', 'sync.kind', 'data.local']);
});

test('设置搜索：匹配标题 / 当前值 / 关键词，大小写不敏感', () => {
  assert.deepEqual(filterSettings(ENTRIES, '同步').map((item) => item.id), ['sync.kind']);
  assert.deepEqual(filterSettings(ENTRIES, 'deepseek').map((item) => item.id), ['model.chat']);
  assert.deepEqual(filterSettings(ENTRIES, 'WEBDAV').map((item) => item.id), ['sync.kind']);
  assert.deepEqual(filterSettings(ENTRIES, '备份').map((item) => item.id), ['data.local']);
  assert.deepEqual(filterSettings(ENTRIES, '不存在的设置'), []);
});

test('搜索结果的 id 去掉分区前缀后才是分区页认识的 L3 行 id', () => {
  assert.equal(rowIdOf(ENTRIES[0]!), 'chat');
  assert.equal(rowIdOf(ENTRIES[1]!), 'kind');
  assert.equal(rowIdOf({ id: 'plain', section: 'model', label: '', value: '', keywords: '' }), 'plain');
});

test('设置默认语言：locales() 排过序，不能拿第一个（en）当默认', () => {
  assert.equal(defaultLocale(['en', 'zh-CN']), 'zh-CN');
  assert.equal(defaultLocale(['en']), 'en');
  assert.equal(defaultLocale([]), '');
});
