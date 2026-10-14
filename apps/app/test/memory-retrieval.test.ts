import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMemoryBlock, memoriesAsBook, selectMemories } from '../src/data/memory-retrieval.ts';
import type { Memory } from '../src/data/types.ts';

/**
 * 长期记忆的检索规则。
 *
 * 检索复用了世界书的扫描器，所以这里要盯的是**映射是否正确**：
 * 关键词命中、重要度排序、预算裁剪、确定性，以及"常量记忆永远在场"。
 */

const memory = (overrides: Partial<Memory> = {}): Memory => ({
  id: 'm1',
  characterId: '',
  text: '旅人怕水。',
  keys: ['水'],
  importance: 50,
  sourceSessionId: '',
  sourceMessageIds: [],
  createdBy: 'user',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const history = (...contents: string[]) => contents.map((content, index) => ({ role: index % 2 === 0 ? ('user' as const) : ('assistant' as const), content }));

test('记忆检索：关键词命中才注入，没命中不出现', () => {
  const memories = [memory({ id: 'm1', keys: ['水'], text: '旅人怕水。' }), memory({ id: 'm2', keys: ['火'], text: '火折子有三根。' })];
  const hit = selectMemories({ memories, messages: history('前面有条河，水声很大') });
  assert.deepEqual(hit.matched.map((item) => item.memory.id), ['m1']);
  assert.deepEqual(hit.matched[0]?.matchedKeys, ['水']);

  const miss = selectMemories({ memories, messages: history('今天天气不错') });
  assert.deepEqual(miss.matched, []);
});

test('记忆检索：没写关键词的记忆是常量，永远在场', () => {
  const memories = [memory({ id: 'm1', keys: [], text: '用户明确要求不要写死亡结局。' })];
  const result = selectMemories({ memories, messages: history('随便聊聊') });
  assert.deepEqual(result.matched.map((item) => item.memory.id), ['m1']);
  assert.equal(result.matched[0]?.reason, 'constant');
});

test('记忆检索：重要度高的排前面（映射到扫描器的顺序）', () => {
  const memories = [
    memory({ id: 'low', keys: ['触发'], text: '不重要的事。', importance: 10 }),
    memory({ id: 'high', keys: ['触发'], text: '很重要的事。', importance: 90 }),
    memory({ id: 'mid', keys: ['触发'], text: '一般的事。', importance: 50 }),
  ];
  const result = selectMemories({ memories, messages: history('触发') });
  assert.deepEqual(result.matched.map((item) => item.memory.id), ['high', 'mid', 'low']);
});

test('记忆检索：预算不够时放进 dropped，而不是静默丢弃', () => {
  const big = '字'.repeat(60);
  const memories = [
    memory({ id: 'a', keys: ['触发'], text: `${big}A`, importance: 90 }),
    memory({ id: 'b', keys: ['触发'], text: `${big}B`, importance: 10 }),
  ];
  const result = selectMemories({ memories, messages: history('触发'), budgetChars: 70 });
  assert.deepEqual(result.matched.map((item) => item.memory.id), ['a']);
  assert.deepEqual(result.dropped.map((item) => item.memory.id), ['b']);
  assert.ok(result.charsUsed <= 70);
});

test('记忆检索：输出与输入顺序无关（两台设备、两次调用都一样）', () => {
  const memories = [
    memory({ id: 'x', keys: ['触发'], text: 'X', importance: 30 }),
    memory({ id: 'y', keys: ['触发'], text: 'Y', importance: 30 }),
  ];
  const forward = selectMemories({ memories, messages: history('触发') });
  const backward = selectMemories({ memories: [...memories].reverse(), messages: history('触发') });
  assert.deepEqual(
    forward.matched.map((item) => item.memory.id),
    backward.matched.map((item) => item.memory.id),
  );
});

test('记忆检索：记忆之间不会互相触发（recursive=false）', () => {
  const memories = [
    memory({ id: 'm1', keys: ['甲'], text: '乙也在这里。' }),
    memory({ id: 'm2', keys: ['乙'], text: '乙的设定。' }),
  ];
  const result = selectMemories({ memories, messages: history('甲来了') });
  assert.deepEqual(result.matched.map((item) => item.memory.id), ['m1']);
});

test('记忆检索：空记忆列表与空正文都能安全处理', () => {
  assert.deepEqual(selectMemories({ memories: [], messages: history('随便') }).matched, []);
  assert.equal(memoriesAsBook([memory({ text: '   ' })]), undefined);
  assert.equal(formatMemoryBlock([]), '');
});

test('记忆注入文本：带标题、按顺序列出', () => {
  const result = selectMemories({
    memories: [memory({ id: 'm1', keys: ['水'], text: '旅人怕水。' })],
    messages: history('水'),
  });
  const block = formatMemoryBlock(result.matched);
  assert.match(block, /【长期记忆】/);
  assert.match(block, /- 旅人怕水。/);
});
