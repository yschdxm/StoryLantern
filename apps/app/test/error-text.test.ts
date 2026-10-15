import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from '../src/data/error-text.ts';

/**
 * `describeError`：把"抛出来的东西"变成能给人看的一句话。
 *
 * 起因是**真机踩到**的：把同步方式切到"本地文件夹"、而 SAF 那条插件还没启用时，
 * 界面显示 `Sync failed: [object Object]`——Tauri 插件拒绝时抛的是普通对象、不是 `Error`，
 * 而旧代码写的是 `cause instanceof Error ? cause.message : String(cause)`，
 * 于是三十多处都可能在用户面前变成 `[object Object]`。
 */

test('describeError：Error / 字符串 / 数字 / null 都给人话', () => {
  assert.equal(describeError(new Error('读取失败')), '读取失败');
  assert.equal(describeError('就是一句话'), '就是一句话');
  assert.equal(describeError(404), '404');
  assert.equal(describeError(null), 'null');
  // message 为空的 Error 至少有名字可看
  assert.equal(describeError(new Error('')), 'Error');
});

test('describeError：Tauri 插件那种普通对象要取到里面的字段', () => {
  assert.equal(describeError({ message: 'Command plugin:saf|list not allowed by ACL' }), 'Command plugin:saf|list not allowed by ACL');
  assert.equal(describeError({ error: 'permission denied' }), 'permission denied');
  assert.equal(describeError({ reason: '还没有选择文件夹' }), '还没有选择文件夹');
  assert.equal(describeError({ detail: '清单不可用' }), '清单不可用');
});

test('describeError：嵌套对象、只有未知字段、以及没法 JSON 的对象都有兜底', () => {
  assert.equal(describeError({ error: { message: '里层的话' } }), '里层的话');
  assert.equal(describeError({ code: 'E_ACL' }), '{"code":"E_ACL"}');
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.equal(describeError(cyclic), '未知错误（对方给了一个没有可读信息的对象）');
  assert.equal(describeError({}), '未知错误（对方给了一个没有可读信息的对象）');
});
