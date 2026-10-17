import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConditions, evaluateExpression, flattenScope, tokenize, truthy } from '../src/expr.ts';

/**
 * 条件表达式求值器：规则与典籍的"条件"都靠它。
 *
 * 两条底线：
 *  1. 未知变量 / 类型不匹配是**错误**，不是静默 false（否则作者会以为规则生效了）；
 *  2. 完全确定性：同一输入必得同一结果（不依赖时间、随机、环境）。
 */

test('表达式：数字/字符串/布尔/null 字面量与算术优先级', () => {
  assert.deepEqual(evaluateExpression('1 + 2 * 3', {}), { value: 7 });
  assert.deepEqual(evaluateExpression('(1 + 2) * 3', {}), { value: 9 });
  assert.deepEqual(evaluateExpression('10 % 3', {}), { value: 1 });
  assert.deepEqual(evaluateExpression('"a" + "b"', {}), { value: 'ab' });
  assert.deepEqual(evaluateExpression('true', {}), { value: true });
  assert.deepEqual(evaluateExpression('null', {}), { value: null });
});

test('表达式：比较与逻辑', () => {
  const scope = { affection: 75, mood: '温柔', trust: 30 };
  assert.deepEqual(evaluateExpression('affection >= 70', scope), { value: true });
  assert.deepEqual(evaluateExpression('affection >= 70 && trust < 40', scope), { value: true });
  assert.deepEqual(evaluateExpression('affection < 50 || trust < 40', scope), { value: true });
  assert.deepEqual(evaluateExpression('!(affection < 50)', scope), { value: true });
  assert.deepEqual(evaluateExpression('mood == "温柔"', scope), { value: true });
  assert.deepEqual(evaluateExpression('mood != "冷淡"', scope), { value: true });
});

test('表达式：一元负号与括号', () => {
  assert.deepEqual(evaluateExpression('-affection + 5', { affection: 10 }), { value: -5 });
  assert.deepEqual(evaluateExpression('((2))', {}), { value: 2 });
});

test('表达式：未知变量是错误，不是 false', () => {
  const result = evaluateExpression('unknown >= 3', {});
  assert.equal(result.value, undefined);
  assert.match(result.error ?? '', /未知变量「unknown」/);
});

test('表达式：类型不匹配是错误', () => {
  assert.match(evaluateExpression('mood >= 3', { mood: '温柔' }).error ?? '', /大小比较需要两个数字或两个字符串/);
  assert.match(evaluateExpression('affection + true', { affection: 1 }).error ?? '', /算术需要数字/);
  assert.match(evaluateExpression('"宽" < 3', {}).error ?? '', /大小比较/);
});

test('表达式：字符串未闭合/括号未闭合/多余内容都会报错', () => {
  assert.ok(evaluateExpression('"abc', {}).error !== undefined);
  assert.ok(evaluateExpression('(1 + 2', {}).error !== undefined);
  assert.ok(evaluateExpression('1 2', {}).error !== undefined);
  assert.ok(evaluateExpression('', {}).error !== undefined);
});

test('条件组：空条件恒成立；AND；出错整体不成立并带原因', () => {
  assert.deepEqual(evaluateConditions([], { a: 1 }), { ok: true, errors: [] });
  assert.deepEqual(evaluateConditions(['a > 0', 'a < 2'], { a: 1 }), { ok: true, errors: [] });
  assert.deepEqual(evaluateConditions(['a > 0', 'a > 2'], { a: 1 }), { ok: false, errors: [] });

  const broken = evaluateConditions(['a > 0', 'b > 0'], { a: 1 });
  assert.equal(broken.ok, false);
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0] ?? '', /未知变量「b」/);
});

test('真值规则：false/0/空串/null/undefined 为假', () => {
  for (const value of [false, 0, '', null, undefined]) assert.equal(truthy(value), false, String(value));
  for (const value of [true, 1, -1, 'x']) assert.equal(truthy(value), true, String(value));
});

test('作用域摊平：会话变量 + 角色变量；同名时会话优先（先写入者）', () => {
  const scope = flattenScope(
    {
      session: { weather: '雨' },
      'character:c1': { affection: 60, weather: '晴' },
      'character:c2': { mood: '警惕' },
    },
    ['c1', 'c2'],
  );
  assert.deepEqual(scope, { weather: '雨', affection: 60, mood: '警惕' });
});

test('词法：中文标识符、下划线、点号与转义引号', () => {
  const tokens = tokenize('好感度 >= 3 && a_b.c == "x\\"y"');
  assert.equal(tokens[0]?.kind, 'ident');
  const result = evaluateExpression('好感度 >= 3', { 好感度: 5 });
  assert.deepEqual(result, { value: true });
  const dotted = evaluateExpression('a_b.c == 1', { 'a_b.c': 1 });
  assert.deepEqual(dotted, { value: true });
});
