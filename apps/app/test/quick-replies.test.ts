import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CardMeta, CharacterCard, QuickReply } from '../../../packages/cards/src/index.ts';
import {
  enabledQuickReplies,
  expandQuickReply,
  listQuickReplies,
  quickRepliesFromSt,
  quickRepliesToSt,
} from '../src/data/quick-replies.ts';

/** B14：快捷回复的纯逻辑（宏展开、按激活卡顺序收集/去重、ST 往返）。 */

const meta = (patch: Partial<CardMeta> = {}): CardMeta => ({
  id: 'c1', schema: 'rolecard/v1', name: '林霜', version: '1.0.0',
  language: 'zh-CN', description: '', rating: 'general', ...patch,
});
const card = (id: string, quickReplies: readonly QuickReply[]): CharacterCard => ({
  card_type: 'character', meta: meta({ id }),
  identity: { name: id, background: '' },
  persona: { summary: '', traits: [], knowledge_boundary: '', ability_boundary: '' },
  speech: { style: '' },
  quick_replies: quickReplies,
});

test('宏展开：{{char}}/{{user}} 生效，未知宏原样保留', () => {
  assert.equal(expandQuickReply('{{char}} 看向 {{user}}', { char: '林霜', user: '旅人' }), '林霜 看向 旅人');
  assert.equal(expandQuickReply('{{user}} 来了', { char: '林霜' }), '你 来了');
  assert.equal(expandQuickReply('{{random}} {{char}}', { char: '林霜' }), '{{random}} 林霜');
});

test('listQuickReplies：按激活卡顺序、同 id 去重、跳过禁用', () => {
  const first = card('a', [
    { id: 'hi', name: '打招呼', content: '你好' },
    { id: 'bye', name: '告辞', content: '再见', enabled: false },
  ]);
  const second = card('b', [
    { id: 'hi', name: '重复', content: '不应覆盖第一条' },
    { id: 'help', name: '求助', content: '帮帮我' },
  ]);
  const replies = listQuickReplies([first, second], ['b', 'a', 'missing']);
  assert.deepEqual(replies.map((reply) => reply.id), ['hi', 'help'], '按激活卡顺序，a 的 hi 去重');
  assert.equal(replies.find((reply) => reply.id === 'hi')?.content, '不应覆盖第一条');
  assert.deepEqual(enabledQuickReplies(first).map((reply) => reply.id), ['hi']);
  assert.deepEqual(listQuickReplies([first, second], ['a']).map((reply) => reply.id), ['hi']);
});

test('ST 往返：quick_replies 原始格式 → 模型 → 原始格式', () => {
  const model = quickRepliesFromSt([
    { id: 'q1', label: '打招呼', message: '{{char}}：你好' },
    { id: 'q2', name: '备用', content: '内容', enabled: false },
    { label: '无 id', message: '自动编号' },
    { message: '' },
    'not-a-record',
  ]);
  assert.deepEqual(model.map((reply) => reply.id), ['q1', 'q2', 'qr-3']);
  assert.equal(model[0]?.name, '打招呼');
  assert.equal(model[1]?.enabled, false);
  assert.equal(model[2]?.id, 'qr-3');
  assert.equal(model[2]?.name, '无 id');
  const back = quickRepliesToSt(model);
  assert.equal(back[0]?.label, '打招呼');
  assert.equal(back[0]?.message, '{{char}}：你好');
  assert.equal(back[1]?.enabled, false);
  assert.deepEqual(quickRepliesFromSt(back).map((reply) => reply.id), model.map((reply) => reply.id));
});
