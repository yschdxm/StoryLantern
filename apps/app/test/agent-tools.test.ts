import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../src/data/types.ts';
import type { Summary } from '../src/data/summary-types.ts';
import type { RequestLogEntry, RequestLogPort } from '../src/data/request-log.ts';
import type { AgentProposalPort, AgentToolDeps } from '../src/data/agent-tool-types.ts';
import { createAgentTools } from '../src/data/agent-tools.ts';

/**
 * Agent 工具注册表（PLAN §7）：只读工具 + 提案工具。
 *
 * 这些测试钉住"Agent 不能偷偷写数据"与"坏参数/没端口时如实报错"——
 * 比工具本身多返回一个字段更重要的是：它不会假装成功。
 */

const messages: Message[] = [
  { id: 'm1', sessionId: 's1', role: 'user', content: '铜铃在夜里响了。', status: 'done', createdAt: 1, candidates: [], selectedCandidateId: '' },
  {
    id: 'm2', sessionId: 's1', role: 'assistant', content: '她抬起头，看向门口。', status: 'done', createdAt: 2, candidates: [], selectedCandidateId: '',
    meta: {
      modelId: 'deepseek-chat', modelLabel: 'DeepSeek', timing: { firstDeltaMs: 120, totalMs: 900 },
      tokens: { prompt: 100, completion: 30, estimated: false },
      citations: [{ index: 1, messageId: 'm1', resolved: true }, { index: 9, resolved: false }],
      reasoning: '先判断来人的意图。', regex: [{ placement: 'ai_output', applied: 1, skipped: [] }],
    },
  },
  { id: 'm3', sessionId: 's2', role: 'assistant', content: '另一个会话里也提到铜铃。', status: 'done', createdAt: 3, candidates: [], selectedCandidateId: '' },
];

const summary: Summary = {
  id: 'sum1', sessionId: 's1', level: 'scene', covers: ['m1', 'm2'], contentHash: 'h1', text: '两人在门口相遇。', createdBy: 'model', updatedAt: 10,
};

const request: RequestLogEntry = {
  id: 'req1', at: 100, sessionId: 's1', model: 'deepseek-chat', url: 'https://api.example/chat/completions',
  byteLength: 1234, body: '{"model":"deepseek-chat"}', status: 'ok', firstDeltaMs: 120, totalMs: 900,
};

interface CreatedProposal { proposalId: string; runId: string; kind: string; summary: string; payload: unknown }

function makeDeps(options: { withRequestLog?: boolean; withProposals?: boolean } = {}) {
  const created: CreatedProposal[] = [];
  const proposals: AgentProposalPort = {
    async create(input) { created.push(input); },
  };
  const requestLog: RequestLogPort = {
    async list() { return [request]; },
    async append() { throw new Error('工具不该写请求日志'); },
    async clear() { throw new Error('工具不该清请求日志'); },
  };
  const store = {
    getState: () => ({ messages, activeSessionId: 's1' }),
    actions: {
      async messagesOf(sessionId: string) { return messages.filter((message) => message.sessionId === sessionId); },
      async summariesOf(sessionId: string) { return sessionId === 's1' ? [summary] : []; },
    },
  };
  const toolDeps: AgentToolDeps = { store, newId: () => 'proposal-test', now: () => 1000 };
  if (options.withRequestLog !== false) toolDeps.requestLog = requestLog;
  if (options.withProposals !== false) toolDeps.proposals = proposals;
  return { toolDeps, created, store, requestLog, proposals };
}
test('searchMessages：大小写不敏感、按时间倒序、支持会话范围与 limit', async () => {
  const registry = createAgentTools(makeDeps().toolDeps);
  const all = await registry.execute('searchMessages', { query: '铜铃' }, { runId: 'r1' });
  const value = all.ok ? (all.value as { count: number; messages: Array<{ id: string }> }) : undefined;
  assert.equal(value?.count, 2, '跨会话时两条都命中');
  assert.deepEqual(value?.messages.map((message) => message.id), ['m3', 'm1'], '最新在前');

  const scoped = await registry.execute('searchMessages', { query: '铜铃', sessionId: 's1', limit: 1 }, { runId: 'r1' });
  assert.deepEqual(scoped.ok ? scoped.value : undefined, {
    query: '铜铃', sessionId: 's1', count: 1,
    messages: [{ id: 'm1', role: 'user', excerpt: '铜铃在夜里响了。', createdAt: 1 }],
  });
});

test('readRange：区间正确、越界返回空并说明原因', async () => {
  const registry = createAgentTools(makeDeps().toolDeps);
  const ok = await registry.execute('readRange', { sessionId: 's1', start: 0, count: 10 }, { runId: 'r1' });
  const value = ok.ok ? (ok.value as { total: number; messages: Array<{ id: string }> }) : undefined;
  assert.equal(value?.total, 2);
  assert.deepEqual(value?.messages.map((message) => message.id), ['m1', 'm2']);

  const empty = await registry.execute('readRange', { sessionId: 's1', start: 99 }, { runId: 'r1' });
  const emptyValue = empty.ok ? (empty.value as { count: number; note: string }) : undefined;
  assert.equal(emptyValue?.count, 0);
  assert.match(emptyValue?.note ?? '', /超出/);
});

test('readSummary：返回分层摘要；没有时明确说明', async () => {
  const registry = createAgentTools(makeDeps().toolDeps);
  const found = await registry.execute('readSummary', { sessionId: 's1' }, { runId: 'r1' });
  assert.match(JSON.stringify(found), /两人在门口相遇/);
  const none = await registry.execute('readSummary', { sessionId: 's2' }, { runId: 'r1' });
  assert.match(JSON.stringify(none), /还没有分层摘要/);
});

test('readRequest：最近一条 / 指定 id / 没有端口都如实返回', async () => {
  const registry = createAgentTools(makeDeps().toolDeps);
  const latest = await registry.execute('readRequest', {}, { runId: 'r1' });
  assert.equal(latest.ok && (latest.value as { request: { id: string } }).request.id, 'req1');
  const byId = await registry.execute('readRequest', { requestLogId: 'missing' }, { runId: 'r1' });
  assert.equal(byId.ok && (byId.value as { found: boolean }).found, false);

  const noPort = createAgentTools(makeDeps({ withRequestLog: false }).toolDeps);
  const unavailable = await noPort.execute('readRequest', {}, { runId: 'r1' });
  assert.equal(unavailable.ok && (unavailable.value as { available: boolean }).available, false);
});

test('diagnoseReply：最后助手消息的模型/token/引用/正则统计；没有助手消息时明确返回', async () => {
  const registry = createAgentTools(makeDeps().toolDeps);
  const result = await registry.execute('diagnoseReply', { sessionId: 's1' }, { runId: 'r1' });
  const value = result.ok ? (result.value as Record<string, unknown>) : {};
  assert.equal(value['messageId'], 'm2');
  assert.deepEqual(value['tokens'], { prompt: 100, completion: 30, estimated: false });
  assert.deepEqual(value['citations'], { count: 2, resolved: 1, unresolved: 1 });
  assert.deepEqual(value['regex'], [{ placement: 'ai_output', applied: 1, skipped: [] }]);
  assert.equal(value['available'], true);

  const none = await registry.execute('diagnoseReply', { sessionId: 'empty-session' }, { runId: 'r1' });
  assert.match(JSON.stringify(none), /还没有助手消息/);
});

test('critiqueText：确定性规则检查，并明确"不是模型判断"', async () => {
  const registry = createAgentTools(makeDeps().toolDeps);
  const input = { text: '你看着她。'.repeat(30) };
  const result = await registry.execute('critiqueText', input, { runId: 'r1' });
  const value = result.ok ? (result.value as { ruleBased: boolean; note: string; metrics: { chars: number }; findings: Array<{ code: string }> }) : undefined;
  assert.equal(value?.ruleBased, true);
  assert.match(value?.note ?? '', /规则检查，不是模型判断/);
  assert.ok((value?.metrics.chars ?? 0) > 0);
  assert.ok((value?.findings.length ?? 0) > 0, '重复短语应被规则抓到');
  assert.deepEqual(result, await registry.execute('critiqueText', input, { runId: 'r1' }), '同输入同输出（确定性）');
});

test('提案工具：guard 默认拒绝；显式 allowGuard 才创建 pending（不写别的数据）', async () => {
  const fake = makeDeps();
  const registry = createAgentTools(fake.toolDeps);
  const blocked = await registry.execute('proposeLorebookPatch', { summary: '补一条', patch: '新内容' }, { runId: 'r1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok ? undefined : blocked.error.code, 'tier-blocked');
  assert.equal(fake.created.length, 0, '拒绝时不能产生提案');

  const allowed = await registry.execute('proposeLorebookPatch', { summary: '补一条', patch: '新内容' }, { runId: 'r1', allowGuard: true });
  assert.equal(allowed.ok, true);
  assert.equal(fake.created.length, 1);
  assert.equal(fake.created[0]?.kind, 'lorebook_patch');
  assert.equal(fake.created[0]?.runId, 'r1');
  assert.match(JSON.stringify(allowed), /pending/);
});

test('坏参数/未知工具/没有提案端口：结构化错误而不是抛异常', async () => {
  const registry = createAgentTools(makeDeps().toolDeps);
  const unknown = await registry.execute('noSuchTool', {}, { runId: 'r1' });
  assert.equal(unknown.ok ? undefined : unknown.error.code, 'unknown-tool');

  const bad = await registry.execute('searchMessages', { query: '' }, { runId: 'r1' });
  assert.equal(bad.ok ? undefined : bad.error.code, 'invalid-arguments');
  assert.match(bad.ok ? '' : bad.error.message, /至少 1 个字符/);

  const badLimit = await registry.execute('searchMessages', { query: 'x', limit: 0 }, { runId: 'r1' });
  assert.equal(badLimit.ok ? undefined : badLimit.error.code, 'invalid-arguments');

  const noPort = createAgentTools(makeDeps({ withProposals: false }).toolDeps);
  const failed = await noPort.execute('proposePromptPatch', { summary: '改语气', patch: '短句' }, { runId: 'r1', allowGuard: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.ok ? undefined : failed.error.code, 'tool-error');
  assert.match(failed.ok ? '' : failed.error.message, /没有接入提案端口/);
});

test('definitions：给模型的是 OpenAI 兼容函数工具；读+提案共 10 个且 schema 都是 object', async () => {
  const registry = createAgentTools(makeDeps().toolDeps);
  const definitions = registry.definitions();
  assert.deepEqual(definitions.map((definition) => definition.function.name).sort(), [
    'critiqueText', 'diagnoseReply', 'proposeLorebookPatch', 'proposeMemoryCompaction',
    'proposePromptPatch', 'proposeReplyRewrite', 'readRange', 'readRequest', 'readSummary', 'searchMessages',
  ]);
  for (const definition of definitions) {
    assert.equal(definition.type, 'function');
    assert.equal(definition.function.parameters.type, 'object');
  }
});
