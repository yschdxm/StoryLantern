import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyProvenance } from '../src/fact-verify.ts';

/**
 * provenance 自动核对的测试。
 *
 * 最要紧的一条是**"引用了但引用错"**：事实的出处其实是另一条消息 —— 这时必须判成"未核对"，
 * 并指出它最可能出自哪里。只测"对的时候对不对"是不够的：核对的价值恰恰在于能把错的挑出来。
 */

const MESSAGES = [
  { id: 'M1', content: '旅人：风从北面灌进走廊，把灯芯压得只剩一线。' },
  { id: 'M2', content: '星野：她说认得，然后从袖中抽出一张更旧的地图。' },
  { id: 'M3', content: '铜铃是父亲留下来的遗物。' },
  { id: 'M4', content: '茶水还热，先喝一口。' },
];

const FACT = {
  id: 'f1',
  subject: '铜铃',
  predicate: '来历',
  object: '父亲留下来的遗物',
  text: '铜铃是父亲留下来的遗物。',
  sourceMessageIds: ['M3'],
};

test('核对通过：引用的消息正是这条事实最可能的出处', () => {
  const check = verifyProvenance(FACT, MESSAGES);
  assert.equal(check.verified, true);
  assert.equal(check.topId, 'M3');
  assert.ok(check.topScore > 0);
  assert.match(check.reason, /正是/);
});

test('引用了但引用错：出处其实是另一个条消息，必须判成未核对并指出真出处', () => {
  const wrong = { ...FACT, sourceMessageIds: ['M4'] };
  const check = verifyProvenance(wrong, MESSAGES);
  assert.equal(check.verified, false, '引用的是茶水那条，而事实出自铜铃那条');
  assert.equal(check.topId, 'M3', '要指出它最可能出自哪条');
  assert.match(check.reason, /另一条消息/);
  console.log(`  引用错：${check.reason}`);
});

test('多条来源里只要命中最可能的那个就算核对通过', () => {
  const multi = { ...FACT, sourceMessageIds: ['M1', 'M3'] };
  assert.equal(verifyProvenance(multi, MESSAGES).verified, true);
});

test('边界：没有来源消息 / 拿不到消息内容 / 查不到相关消息，都要给出可读的原因', () => {
  const noSource = verifyProvenance({ ...FACT, sourceMessageIds: [] }, MESSAGES);
  assert.equal(noSource.verified, false);
  assert.match(noSource.reason, /没有来源消息/);

  const noMessages = verifyProvenance(FACT, []);
  assert.equal(noMessages.verified, false);
  assert.match(noMessages.reason, /拿不到消息内容/);

  const orphan = verifyProvenance(
    { ...FACT, subject: '量子', object: '计算机', text: '量子计算机很冷。', sourceMessageIds: ['M3'] },
    MESSAGES,
  );
  assert.equal(orphan.verified, false);
  assert.match(orphan.reason, /找不到任何相关消息/);
});

test('长而无关的消息不会靠体量压过真正那条（BM25 的长度归一在这里有实际作用）', () => {
  const noise = {
    id: 'M9',
    content: '旅人：风从北面灌进走廊，把灯芯压得只剩一线。星野：她说认得，然后从袖中抽出一张更旧的地图。'.repeat(30),
  };
  const check = verifyProvenance(FACT, [...MESSAGES, noise]);
  assert.equal(check.topId, 'M3', '真正那条消息应当仍然排第一');
  assert.equal(check.verified, true);
});
