import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandMacros } from '../src/data/macros.ts';

/** 宏只有两个：char/user；未知宏原样保留；展开是确定性纯函数。 */

test('{{char}} / {{user}} 展开；user 为空回落「你」，char 缺失不猜', () => {
  assert.equal(expandMacros('{{char}} 看着 {{user}}。', { charName: '林霜', userName: '旅人' }), '林霜 看着 旅人。');
  assert.equal(expandMacros('{{user}} 来了', { charName: '林霜' }), '你 来了');
  assert.equal(expandMacros('{{ char }}的铃', { charName: '林霜' }), '林霜的铃', '宏名两侧允许空白');
  assert.equal(expandMacros('{{char}} 出场', {}), '{{char}} 出场', '没有成员时保留字面量，不虚构名字');
});

test('未知宏原样保留（不猜随机/变量/时间）', () => {
  assert.equal(expandMacros('{{random}} {{mood}} {{time}}', { charName: '林霜' }), '{{random}} {{mood}} {{time}}');
  assert.equal(expandMacros('arr[0] 与 {single}', { charName: '林霜' }), 'arr[0] 与 {single}');
});

test('确定性：同输入同输出（不引入时间/随机）', () => {
  const context = { charName: '林霜', userName: '旅人' };
  const first = expandMacros('{{char}} + {{user}}', context);
  assert.equal(first, '林霜 + 旅人');
  assert.equal(expandMacros('{{char}} + {{user}}', context), first);
});
