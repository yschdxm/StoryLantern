import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, tokenize, type RetrievalDoc } from '../src/retrieval.ts';

/**
 * 词法检索（BM25）的单元测试。
 *
 * 测的是"能不能把该找的找出来、不该找的别乱给"：中文双字切片、排名、limit/kinds 边界、空查询。
 * 面向语义改写的极限在 eval/long-chat/retrieval.test.ts 里如实量（那里会故意用改写式提问）。
 */

function docs(...texts: string[]): RetrievalDoc[] {
  return texts.map((text, index) => ({ id: `D${index + 1}`, text, kind: 'message' }));
}

test('切词：中文按双字、拉丁按词、标点丢掉、单个汉字保留', () => {
  assert.deepEqual(tokenize('她的真名是阿霜'), ['她的', '的真', '真名', '名是', '是阿', '阿霜']);
  assert.ok(tokenize('灯').includes('灯'), '单个汉字不能被切空');
  assert.ok(tokenize('Key: value 42!').includes('key'));
  assert.ok(tokenize('Key: value 42!').includes('value'));
  assert.ok(tokenize('Key: value 42!').includes('42'));
  assert.deepEqual(tokenize('，。！？ '), [], '只有标点空白时应当没有词');
});

test('排名：问到哪条，哪条就排第一（哪怕语料里全是同风格的填充句）', () => {
  const corpus = docs(
    '风声从隘口灌进来，把灯芯压得只剩一线。',
    '她把地图上的折痕抚平，然后才抬眼。',
    '她的真名是阿霜，从没跟人说过。',
    '茶水还热，先喝一口。',
    '天亮之前别睡，风声会骗人。',
    '旧地图上这里画着一棵树。',
  );
  const ranked = retrieve('真名是什么', corpus);
  assert.equal(ranked[0]?.id, 'D3', '含「真名」的那条必须排第一');
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test('边界：空查询返回空、查不到就返回空（不兜底给无关文档）', () => {
  const corpus = docs('灯还亮着。', '铜铃放在桌上。');
  assert.deepEqual(retrieve('', corpus), []);
  assert.deepEqual(retrieve('   。，', corpus), []);
  assert.deepEqual(retrieve('量子计算机', corpus), [], '一个词都不命中时不该硬塞结果');
  assert.deepEqual(retrieve('灯', []), []);
});

test('limit 与 kinds：能限制条数，也能只在某一类里检索', () => {
  const corpus: RetrievalDoc[] = [
    { id: 'M1', text: '铜铃是父亲留下来的遗物。', kind: 'message' },
    { id: 'S1', text: '这一段的摘要：提到铜铃与父亲。', kind: 'summary', covers: ['M1'] },
    { id: 'L1', text: '设定：铜铃是守夜人的信物。', kind: 'lore' },
  ];
  const all = retrieve('铜铃', corpus);
  assert.equal(all.length, 3, '三条都该命中');
  assert.equal(retrieve('铜铃', corpus, { limit: 1 }).length, 1);
  const onlySummaries = retrieve('铜铃', corpus, { kinds: ['summary'] });
  assert.deepEqual(
    onlySummaries.map((item) => item.id),
    ['S1'],
  );
  assert.deepEqual(onlySummaries[0]?.covers, ['M1'], '摘要应当把覆盖范围带出来，便于回溯');
});

test('空白与标点、数字混排不会把检索弄崩', () => {
  const corpus = docs('第 9999 条：旧地图上这里画着一棵树。', '❄️ 风、雪、灯。');
  assert.equal(retrieve('第 9999 条', corpus)[0]?.id, 'D1');
  assert.ok(retrieve('风', corpus).length >= 1, 'emoji 与顿号不该让切词失效');
});
