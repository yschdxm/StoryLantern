import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../src/data/types.ts';
import { displayContentOf, previewOfSource } from '../src/screens/chat/display.ts';

/**
 * 气泡展示规则：assistant 去掉旧引用标记（不改库）；用户消息原样。
 * 旧消息没有 meta 也走同一条规则。
 */

function messageOf(role: Message['role'], content: string, meta?: Message['meta']): Message {
  return {
    id: 'm1',
    sessionId: 's1',
    role,
    content,
    status: 'done',
    createdAt: 0,
    candidates: [],
    selectedCandidateId: '',
    ...(meta === undefined ? {} : { meta }),
  };
}

test('assistant：展示时去掉 [n] 标记，但库里的 content 不变', () => {
  const message = messageOf('assistant', '他点头（[12][13]）。');
  assert.equal(displayContentOf(message), '他点头（）。');
  assert.equal(message.content, '他点头（[12][13]）。', '不能改库');
});

test('用户消息原样：用户真的可能打 [1]', () => {
  assert.equal(displayContentOf(messageOf('user', '看第 [1] 条')), '看第 [1] 条');
});

test('previewOfSource：压成一行并截断；空内容返回 undefined', () => {
  assert.equal(previewOfSource(`  a${String.fromCharCode(10)} b  `), 'a b');
  assert.equal(previewOfSource('   '), undefined);
  assert.ok((previewOfSource('x'.repeat(200)) ?? '').endsWith('…'));
});
