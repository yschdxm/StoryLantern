import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPEND_CHUNK, chunkOps } from '../src/data/op-message-store.ts';

/**
 * 宿主对每次 ops.append 有条数上限（wire_ops.rs 的 MAX_OPS_PER_APPEND = 5000）。
 * 批量导入必须分片，否则整批被拒——真机上导入 1 万条时就是这么被挡下的
 * （报错："一次最多追加 5000 条 op"）。这里把分片规则钉住。
 */

test('chunkOps：空数组切出 0 片', () => {
  assert.deepEqual(chunkOps([]), []);
});

test('chunkOps：刚好一片时不切', () => {
  assert.deepEqual(chunkOps([1, 2, 3], 3), [[1, 2, 3]]);
});

test('chunkOps：超过一片时按大小切，且不丢不重', () => {
  const items = Array.from({ length: APPEND_CHUNK * 2 + 1 }, (_, index) => index);
  const chunks = chunkOps(items);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0]?.length, APPEND_CHUNK);
  assert.deepEqual(chunks[2]?.length, 1);
  assert.deepEqual(chunks.flat(), items, '切完拼回去必须与原来一致');
  assert.ok(APPEND_CHUNK < 5000, '分片必须小于宿主的 5000 上限，留余量');
});

test('chunkOps：非法分片大小直接报错，不静默切成死循环', () => {
  assert.throws(() => chunkOps([1], 0), /分片大小/);
});
