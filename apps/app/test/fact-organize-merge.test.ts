import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEAR_DUPLICATE, recomputeFacts } from '../src/data/fact-organize.ts';

/**
 * 近似重复合并（离线；用一个**确定性**假向量源，不碰网络）。
 *
 * 背景：真实模型会把同一句话拆成两三条（第四十八节实测：`她｜真名｜阿霜` 与
 * `她｜保密状态｜从没跟人说过自己的真名`），而精确去重只比"同主语+同谓语+同宾语"，合不掉。
 *
 * 三条要守住的行为：
 *  1. 给了向量源 → 近似的合并成一条，且**来源取并集**（不丢出处）；
 *  2. 没给向量源 → **不猜**，退回精确去重（宁可多留一条，也不错并两条）；
 *  3. 向量源抛错 → 抽取本身不能失败，退回精确去重的结果。
 */

const PROPOSALS = JSON.stringify([
  { subject: '她', predicate: '真名', object: '阿霜', text: '她的真名是阿霜。', sources: [1] },
  { subject: '她', predicate: '保密状态', object: '从没跟人说过自己的真名', text: '她从没跟人说过自己的真名，真名是阿霜。', sources: [1, 2] },
  { subject: '隘口的守夜人', predicate: '名字', object: '老周', text: '隘口的守夜人叫老周。', sources: [2] },
]);

const reply = async (): Promise<string> => PROPOSALS;

const HISTORY = [
  { id: 'm1', role: 'user' as const, content: '她的真名是阿霜，从没跟人说过。' },
  { id: 'm2', role: 'assistant' as const, content: '隘口的守夜人叫老周。' },
];

/** 确定性假向量源：含"阿霜/真名"的落在几乎同一方向，其它落在另一个方向。 */
const embedNearlySame = async (texts: readonly string[]): Promise<number[][]> =>
  texts.map((text) => (text.includes('真名') ? [0.999, 0.02, 0] : [0, 1, 0]));

const SETTINGS = {
  'model.profiles': JSON.stringify([
    { id: 'p', name: 'x', baseUrl: 'https://example.invalid/v1', model: 'm', temperature: 0, maxTokens: 1024, tasks: ['extract'], enabled: true },
  ]),
};

test('给了向量源：近似的合并成一条，来源取并集', async () => {
  const result = await recomputeFacts({ settings: SETTINGS, history: HISTORY, existing: [], reply, embed: embedNearlySame });
  assert.equal(result.drafts.length, 2, '三条草稿里两条近似 → 合并成两条');
  assert.equal(result.merged, 1);
  const kept = result.drafts.find((draft) => draft.predicate === '真名');
  assert.deepEqual(kept?.sourceMessageIds, ['m1', 'm2'], '合并要并集来源，不能丢出处');
});

test('没给向量源：不猜，退回精确去重（三条都留着）', async () => {
  const result = await recomputeFacts({ settings: SETTINGS, history: HISTORY, existing: [], reply });
  assert.equal(result.drafts.length, 3);
  assert.equal(result.merged, 0);
});

test('向量源抛错：抽取不失败，退回精确去重的结果', async () => {
  const result = await recomputeFacts({
    settings: SETTINGS,
    history: HISTORY,
    existing: [],
    reply,
    embed: async () => {
      throw new Error('向量来源挂了');
    },
  });
  assert.equal(result.drafts.length, 3);
  assert.equal(result.merged, 0);
});

test('阈值本身有据可依：0.65 落在"无关 0.307"与"被拆开 0.709～0.824"之间', () => {
  assert.ok(NEAR_DUPLICATE > 0.307 && NEAR_DUPLICATE < 0.709);
});
