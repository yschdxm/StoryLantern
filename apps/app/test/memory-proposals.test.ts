import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PROPOSALS,
  PROPOSAL_INSTRUCTION,
  buildProposalMessages,
  parseProposals,
  proposalToDraft,
} from '../src/data/memory-proposals.ts';
import type { Memory } from '../src/data/types.ts';

/**
 * 记忆整理建议的解析必须扛得住真实模型的坏输出——套代码块、前后多说两句、
 * 字段类型不对、给出空数组。这些都不是异常，是常态。
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

test('解析：正常 JSON 数组', () => {
  const proposals = parseProposals('[{"text":"星野在隘口守了三年。","keys":["隘口"],"importance":80}]');
  assert.deepEqual(proposals, [{ text: '星野在隘口守了三年。', keys: ['隘口'], importance: 80 }]);
});

test('解析：套了代码块 / 前后多说两句 / 包了一层对象都认得出来', () => {
  const fenced = '```json\n[{"text":"A","keys":[],"importance":1}]\n```';
  assert.equal(parseProposals(fenced)[0]?.text, 'A');

  const chatty = '好的，我整理出以下内容：\n[{"text":"B","keys":[],"importance":2}]\n希望对你有帮助。';
  assert.equal(parseProposals(chatty)[0]?.text, 'B');

  const wrapped = '{"memories":[{"text":"C","keys":[],"importance":3}]}';
  assert.equal(parseProposals(wrapped)[0]?.text, 'C');
});

test('解析：每行一条的松散输出也能收', () => {
  const loose = '- {"text":"D","keys":["d"],"importance":40}\n- {"text":"E","keys":[],"importance":60}';
  const proposals = parseProposals(loose);
  assert.deepEqual(proposals.map((item) => item.text), ['D', 'E']);
});

test('解析：字段类型不对时兜底，而不是丢掉整条', () => {
  const messy = JSON.stringify([
    { content: '用 content 字段也行', keywords: '甲， 乙', importance: '70' },
    { text: '重要度越界', keys: 42, importance: 999 },
    { text: '   ' },
    { notText: 'x' },
    '字符串条目',
    null,
  ]);
  const proposals = parseProposals(messy);
  assert.deepEqual(proposals, [
    { text: '用 content 字段也行', keys: ['甲', '乙'], importance: 70 },
    { text: '重要度越界', keys: [], importance: 100 },
  ]);
});

test('解析：重复条目只留一条，与已有记忆重复时标出 duplicateOf', () => {
  const raw = JSON.stringify([
    { text: '旅人怕水。', keys: ['水'], importance: 50 },
    { text: '旅人怕水。', keys: [], importance: 50 },
    { text: ' 旅人 怕水 ', keys: [], importance: 50 },
    { text: '新的事情。', keys: [], importance: 50 },
  ]);
  const proposals = parseProposals(raw, { existing: [memory()] });
  assert.deepEqual(proposals.map((item) => item.text), ['旅人怕水。', '新的事情。']);
  assert.equal(proposals[0]?.duplicateOf, 'm1');
  assert.equal(proposals[1]?.duplicateOf, undefined);
});

test('解析：空数组 / 全是废话 / 完全不是 JSON 都返回空建议（不抛错）', () => {
  assert.deepEqual(parseProposals('[]'), []);
  assert.deepEqual(parseProposals('这段对话没什么值得记的。'), []);
  assert.deepEqual(parseProposals(''), []);
  assert.deepEqual(parseProposals('{"a":1}'), []);
});

test('解析：条数上限生效（一次给太多用户会全都不看）', () => {
  const raw = JSON.stringify(Array.from({ length: 30 }, (_, index) => ({ text: `第 ${index + 1} 条`, keys: [], importance: 50 })));
  assert.equal(parseProposals(raw).length, MAX_PROPOSALS);
});

test('提示词：把已有记忆带上（避免重复）、只给最近的对话、讲清输出格式', () => {
  const messages = buildProposalMessages({
    characterName: '星野',
    history: Array.from({ length: 80 }, (_, index) => ({ role: 'user' as const, content: `第 ${index + 1} 句` })),
    existing: [memory()],
    maxMessages: 10,
  });
  assert.equal(messages.length, 1);
  const content = messages[0]?.content ?? '';
  assert.match(content, /当前角色：星野/);
  assert.match(content, /已有记忆（不要重复这些）：\n- 旅人怕水。/);
  assert.match(content, /第 80 句/);
  assert.ok(!content.includes('第 69 句'), '只带最近的 10 条');
  assert.match(content, /最多给出 8 条建议/);
  assert.match(PROPOSAL_INSTRUCTION, /JSON 数组/);
  assert.match(PROPOSAL_INSTRUCTION, /不要续写剧情/, '边界必须写清：agent 只整理');
});

test('提示词：失败消息不进整理材料（错误文本不该被记成设定）', () => {
  const messages = buildProposalMessages({
    characterName: '',
    history: [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '请求失败：连不上', status: 'error' },
      { role: 'assistant', content: '' },
    ],
  });
  const content = messages[0]?.content ?? '';
  assert.ok(!content.includes('请求失败'));
  assert.match(content, /在吗/);
});

test('落地：建议转成草稿时标上来源与 agent 身份', () => {
  const draft = proposalToDraft(
    { text: '星野在隘口守了三年。', keys: ['隘口'], importance: 80 },
    { characterId: 'c1', sessionId: 's1', messageIds: ['msg1', 'msg2'] },
  );
  assert.deepEqual(draft, {
    characterId: 'c1',
    text: '星野在隘口守了三年。',
    keys: ['隘口'],
    importance: 80,
    sourceSessionId: 's1',
    sourceMessageIds: ['msg1', 'msg2'],
    createdBy: 'agent',
  });
});
