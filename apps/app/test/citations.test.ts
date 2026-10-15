import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCitations, formatNumbered, numberedHistory, parseCitationIndices } from '../src/data/citations.ts';

/**
 * 「引用正确」的测试。三条要钉住的性质：
 *  1. 编号能从回答里**宽容**地取出来（[3] / [3,7] / [3、7]），越界的编号不算数；
 *  2. **"没引用"与"引用了但引用错"必须分开报** —— 后者才是需要被看见的那种错；
 *  3. 引用核对是**可判**的：同一套窗口下，指对就是 correct，指错就是 wrong-citation。
 */

const WINDOW = [
  { id: 'M1' },
  { id: 'M2' },
  { id: 'M3' },
  { id: 'M4' },
];

const supports = (id: string): boolean => id === 'M3';

test('编号解析：宽容但去重保序，认 [3,7] 与 [3、7]，不认范围也不认中文括号', () => {
  assert.deepEqual(parseCitationIndices('铜铃是遗物（[3]）。'), [3]);
  assert.deepEqual(parseCitationIndices('见 [1][2] 与 [1]'), [1, 2]);
  assert.deepEqual(parseCitationIndices('见 [2, 3]'), [2, 3]);
  assert.deepEqual(parseCitationIndices('见 [2、3]'), [2, 3]);
  assert.deepEqual(parseCitationIndices('没有引用'), []);
  assert.deepEqual(parseCitationIndices('范围 [1-3] 不认'), []);
  assert.deepEqual(parseCitationIndices('中文括号（3）不认'), []);
});

test('编号交给模型：第 n 条就是 [n]，编号前缀只加在消息内容上', () => {
  assert.equal(formatNumbered('茶水还热。', 12), '[12] 茶水还热。');
  const numbered = numberedHistory([
    { id: 'M1', content: '甲' },
    { id: 'M2', content: '乙' },
  ]);
  assert.deepEqual(
    numbered.map((item) => item.content),
    ['[1] 甲', '[2] 乙'],
  );
  assert.deepEqual(
    numbered.map((item) => item.index),
    [1, 2],
  );
});

test('引用核对：指对是 correct，指错是 wrong-citation（"答对了但引用错"必须被挑出来）', () => {
  const right = checkCitations('铜铃是父亲留下来的遗物（[3]）。', WINDOW, supports);
  assert.equal(right.verdict, 'correct');
  assert.deepEqual(right.ids, ['M3']);

  const wrong = checkCitations('铜铃是父亲留下来的遗物（[4]）。', WINDOW, supports);
  assert.equal(wrong.verdict, 'wrong-citation', '答案对、引用错 —— 这正是要抓的');
  assert.deepEqual(wrong.ids, ['M4']);
  assert.match(wrong.reason, /没有一条支持/);
  console.log(`  引用错：${wrong.reason}`);
});

test('没引用与越界要分开报，不能混成一种', () => {
  const none = checkCitations('铜铃是父亲留下来的遗物。', WINDOW, supports);
  assert.equal(none.verdict, 'no-citation');
  assert.match(none.reason, /没有引用编号/);

  const beyond = checkCitations('……（[9]）', WINDOW, supports);
  assert.equal(beyond.verdict, 'unresolvable');
  assert.match(beyond.reason, /不在对话窗口里/);

  // 一个越界 + 一个正确：仍然算 correct，但括号里要说清有越界
  const mixed = checkCitations('……（[9][3]）', WINDOW, supports);
  assert.equal(mixed.verdict, 'correct');
  assert.match(mixed.reason, /越界/);
});
