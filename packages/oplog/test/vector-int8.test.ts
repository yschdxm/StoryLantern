import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInt8Index, int8TopK, quantizeInt8 } from '../src/vector-int8.ts';
import { cosineSimilarity } from '../src/retrieval-hybrid.ts';

/**
 * int8 检索：**它不是浮点检索**，测试要把这个边界钉住。
 *
 * 两类断言：
 *  1. 量化本身的误差有界（对称量化，误差 ≤ scale/2，且不改变"谁更近"这种粗判断）；
 *  2. 搜出来的结果与**浮点暴力**高度一致（recall），但允许少量分歧 —— 因此用 recall 阈值而不是逐条相等。
 *
 * 用固定 seed 的伪随机（可复现），因为"近似算法"的测试如果跟着随机数走，红了也没法查。
 */

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(random: () => number, dimension: number): number[] {
  return Array.from({ length: dimension }, () => random() * 2 - 1);
}

test('量化：误差有界（≤ scale/2），全零向量不炸', () => {
  const random = rng(7);
  const vector = randomVector(random, 64);
  const quantized = quantizeInt8(vector);
  assert.ok(quantized.scale > 0);
  for (let index = 0; index < vector.length; index += 1) {
    const restored = (quantized.values[index] as number) * quantized.scale;
    const error = Math.abs(restored - (vector[index] as number));
    assert.ok(error <= quantized.scale / 2 + 1e-9, `第 ${index} 维误差 ${error} 超过 scale/2`);
  }
  const zero = quantizeInt8([0, 0, 0]);
  assert.equal(zero.scale, 0);
  assert.deepEqual([...zero.values], [0, 0, 0]);
  assert.equal(zero.norm, 0);
});

test('平面数据上：int8 top-1 与浮点暴力 top-1 一致', () => {
  const random = rng(20261016);
  const dimension = 128;
  const vectors = Array.from({ length: 2_000 }, () => randomVector(random, dimension));
  const query = randomVector(random, dimension);
  const index = buildInt8Index(vectors);

  const floatBest = vectors
    .map((vector, doc) => ({ doc, score: cosineSimilarity(query, vector) }))
    .sort((left, right) => right.score - left.score)[0];

  const int8 = int8TopK(query, index, 1);
  assert.equal(int8.length, 1);
  assert.equal(int8[0]?.doc, floatBest?.doc, '粗筛的 top-1 必须与精确检索一致（否则这层没意义）');
});

test('recall@10 达标（近似检索的验收方式），且分数与浮点余弦接近', () => {
  const random = rng(42);
  const dimension = 256;
  const count = 5_000;
  const vectors = Array.from({ length: count }, () => randomVector(random, dimension));
  const index = buildInt8Index(vectors);

  let hits = 0;
  let worstGap = 0;
  const queries = 50;
  for (let queryIndex = 0; queryIndex < queries; queryIndex += 1) {
    const query = randomVector(random, dimension);
    const floatTop = vectors
      .map((vector, doc) => ({ doc, score: cosineSimilarity(query, vector) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
    const int8Top = int8TopK(query, index, 10);
    const expected = new Set(floatTop.map((item) => item.doc));
    for (const item of int8Top) if (expected.has(item.doc)) hits += 1;
    // 同一条数据的分数差：int8 近似 vs 浮点精确
    const topHit = int8Top[0];
    if (topHit !== undefined) {
      const exact = floatTop.find((item) => item.doc === topHit.doc);
      if (exact !== undefined) worstGap = Math.max(worstGap, Math.abs(exact.score - topHit.score));
    }
  }
  const recall = hits / (queries * 10);
  assert.ok(recall >= 0.95, `recall@10 应 ≥0.95，实际 ${recall.toFixed(3)}`);
  assert.ok(worstGap < 0.02, `top-1 分数与精确余弦的差应很小，实际最大 ${worstGap.toFixed(4)}`);
});

test('边界：limit 大于条数、维度不一致、空索引都不该抛错', () => {
  const random = rng(1);
  const vectors = [randomVector(random, 32), randomVector(random, 32)];
  const index = buildInt8Index(vectors);
  assert.equal(int8TopK(randomVector(random, 32), index, 99).length, 2);
  // 查询维度比索引短：按较短的一截算（不越界、不抛）
  assert.equal(int8TopK([0.5], index, 5).length >= 0, true);
  assert.deepEqual(int8TopK(randomVector(random, 32), buildInt8Index([]), 5), []);
  assert.deepEqual(int8TopK(randomVector(random, 32), index, 0), []);
});
