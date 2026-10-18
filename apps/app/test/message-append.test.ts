import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendMessageWithMeta } from '../src/data/message-append.ts';
import type { MessageStore } from '../src/data/repository.ts';
import type { Message, MessageMeta } from '../src/data/types.ts';

/**
 * 位置参数回归：`append(status?, createdAt?, meta?)`。
 *
 * 真机踩过：有 meta、没有 createdAt 时，meta 被当成 createdAt → 消息时间显示 `NaN`，
 * 思考链/引用全丢。这里用假仓储钉住"第 5 位是 createdAt、第 6 位才是 meta"。
 */

function captureStore(): { calls: unknown[][]; store: MessageStore } {
  const calls: unknown[][] = [];
  const store = {
    async append(...args: unknown[]): Promise<Message> {
      calls.push(args);
      return {} as Message;
    },
  } as unknown as MessageStore;
  return { calls, store };
}

const meta: MessageMeta = {
  modelId: 'p1',
  tokens: { prompt: 10, completion: 2, estimated: true },
  timing: { firstDeltaMs: 5, totalMs: 20 },
  reasoning: '先想一下',
};

test('无 meta：参数与旧行为一致（可省略 createdAt）', async () => {
  const { calls, store } = captureStore();
  await appendMessageWithMeta(store, 's1', 'assistant', '正文', { status: 'done' });
  assert.deepEqual(calls[0], ['s1', 'assistant', '正文', 'done']);
});

test('有 meta：createdAt 显式占位，meta 落在第 6 位', async () => {
  const { calls, store } = captureStore();
  await appendMessageWithMeta(store, 's1', 'assistant', '正文', { status: 'stopped' }, meta);
  const [sessionId, role, content, status, createdAt, gotMeta] = calls[0] as unknown[];
  assert.equal(sessionId, 's1');
  assert.equal(role, 'assistant');
  assert.equal(content, '正文');
  assert.equal(status, 'stopped');
  assert.equal(typeof createdAt, 'number');
  assert.ok((createdAt as number) > 0);
  assert.deepEqual(gotMeta, meta);
});

test('createdAt 显式传入时原样使用', async () => {
  const { calls, store } = captureStore();
  await appendMessageWithMeta(store, 's1', 'assistant', '正文', { createdAt: 123 }, meta);
  assert.deepEqual(calls[0], ['s1', 'assistant', '正文', 'done', 123, meta]);
});
