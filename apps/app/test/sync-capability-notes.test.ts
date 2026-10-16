import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityNotes } from '../src/data/sync/app-sync.ts';

/**
 * "能力降级必须说出来"。
 *
 * 为什么值得单测：降级本身是**静默**的 —— 同步照样成功，只是旧快照永远不回收（占用只涨不降），
 * 或者不认条件写的网盘要多传一次。用户看到的只有"完成"，不会知道存储为什么一直涨。
 * 这段文案就是把静默的代价说出来；漏说 = 让人以为一切正常。
 */

test('无删除 + 无条件写：两条都要说清楚（占用只涨不降 / 靠内容寻址兜底）', () => {
  const notes = capabilityNotes({
    conditionalPut: false,
    rangeRead: false,
    delete: false,
    listPagination: false,
    watch: false,
  });
  assert.equal(notes.length, 2);
  assert.match(notes[0] ?? '', /不支持删除/);
  assert.match(notes[0] ?? '', /占用只涨不降/);
  assert.match(notes[1] ?? '', /不认条件写/);
  assert.match(notes[1] ?? '', /内容寻址/);
});

test('能力齐全时一句都不说（不能拿无关提示烦人）', () => {
  assert.deepEqual(
    capabilityNotes({ conditionalPut: true, rangeRead: true, delete: true, listPagination: true, watch: false }),
    [],
  );
});

test('探测不到（undefined）时不乱说：按后端的默认声明处理', () => {
  assert.deepEqual(capabilityNotes(undefined), []);
});

test('只有范围读缺失时不提示：范围读现在只是"能有更好"，缺了不影响正确性', () => {
  const notes = capabilityNotes({
    conditionalPut: true,
    rangeRead: false,
    delete: true,
    listPagination: true,
    watch: false,
  });
  assert.deepEqual(notes, []);
});
