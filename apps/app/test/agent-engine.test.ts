import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AgentChatClient,
  AgentChatReply,
  AgentChatRequest,
  AgentCheckpoint,
  AgentEngineEvent,
  AgentRunStore,
} from '../src/data/agent-engine.ts';
import { runAgent, resumeAgent } from '../src/data/agent-engine.ts';
import type { AgentToolExecution, AgentToolRegistry } from '../src/data/agent-tools.ts';

/**
 * Agent 运行引擎（PLAN §7）：循环、工具、预算、取消、恢复。
 *
 * 用假 ChatClient / 假 store 覆盖全部终态；这些测试的意义是：
 * **任何停止条件都必须留下 finish op + 可解释的 stopReason**，不能悄悄停。
 */

const budget = { maxRounds: 5, maxToolCalls: 10 };

function fakeChat(replies: readonly AgentChatReply[]): AgentChatClient & { requests: AgentChatRequest[] } {
  const requests: AgentChatRequest[] = [];
  let index = 0;
  return {
    requests,
    async reply(request, handlers) {
      requests.push(request);
      if (handlers?.signal?.aborted === true) return { text: '已取消', aborted: true };
      const reply = replies[index];
      index += 1;
      if (reply === undefined) throw new Error(`fakeChat 没有准备第 ${index} 个回复`);
      return reply;
    },
  };
}

interface FinishRecord { runId: string; status: string; at: number }

function fakeStore(checkpoint?: AgentCheckpoint) {
  const starts: Array<Record<string, unknown>> = [];
  const events: Array<{ runId: string; eventId: string; kind: string; data: unknown; at: number }> = [];
  const finishes: FinishRecord[] = [];
  const store: AgentRunStore = {
    async startRun(input) { starts.push(input as unknown as Record<string, unknown>); },
    async appendEvent(input) { events.push(input); },
    async finishRun(input) { finishes.push(input); },
    async loadCheckpoint() { return checkpoint; },
  };
  return { store, starts, events, finishes };
}

function stubTools(execute: (name: string) => AgentToolExecution = () => ({ ok: true, value: { found: true } })): AgentToolRegistry {
  return {
    list: () => [],
    definitions: () => [],
    has: () => true,
    execute: async (name) => execute(name),
  };
}

const call = (id: string, name: string, args: unknown = { query: '铜铃' }) => ({ id, name, arguments: args });

test('直接回答：一轮无工具调用 → done；start/finish op 与事件都落库', async () => {
  const chat = fakeChat([{ text: '我看过了，这段没问题。' }]);
  const fake = fakeStore();
  const events: AgentEngineEvent[] = [];
  const result = await runAgent({ goal: '看看这段', chat, tools: stubTools(), store: fake.store, budget, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'done');
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.text, '我看过了，这段没问题。');
  assert.equal(result.rounds, 1);
  assert.equal(result.toolCalls, 0);
  assert.equal(fake.starts.length, 1);
  assert.deepEqual(fake.finishes.map((finish) => finish.status), ['done']);
  assert.deepEqual(events.map((event) => event.kind), ['status', 'assistant', 'checkpoint', 'status']);
  assert.deepEqual(chat.requests[0]?.messages, [{ role: 'user', content: '看看这段' }]);
  assert.equal(chat.requests[0]?.tools?.length, 0);
});

test('一次工具调用：assistant tool_calls 与 tool 结果都追加进 messages，再让模型总结', async () => {
  const chat = fakeChat([
    { text: '', toolCalls: [call('c1', 'searchMessages', '{"query":"铜铃"}')] },
    { text: '找到了，铜铃在夜里响过。' },
  ]);
  const fake = fakeStore();
  const result = await runAgent({ goal: '找铜铃', chat, tools: stubTools(), store: fake.store, budget });
  assert.equal(result.status, 'done');
  assert.equal(result.toolCalls, 1);
  const second = chat.requests[1];
  assert.ok(second !== undefined);
  const assistant = second.messages.find((message) => message.role === 'assistant' && message.toolCalls !== undefined);
  assert.equal(assistant?.toolCalls?.[0]?.id, 'c1');
  const toolMessage = second.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage?.toolCallId, 'c1');
  assert.match(toolMessage?.content ?? '', /found/);
  const kinds = fake.events.map((event) => event.kind);
  assert.deepEqual(kinds.filter((kind) => kind === 'tool'), ['tool']);
  assert.deepEqual(kinds.filter((kind) => kind === 'tool_result'), ['tool_result']);
});

test('多工具：同一轮 2 个调用逐个执行并计数', async () => {
  const chat = fakeChat([
    { text: '先查两处。', toolCalls: [call('c1', 'searchMessages'), call('c2', 'readSummary', { sessionId: 's1' })] },
    { text: '都查完了。' },
  ]);
  const fake = fakeStore();
  const result = await runAgent({ goal: '查', chat, tools: stubTools(), store: fake.store, budget });
  assert.equal(result.status, 'done');
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(fake.events.filter((event) => event.kind === 'tool').map((event) => (event.data as { toolCallId: string }).toolCallId), ['c1', 'c2']);
  assert.equal(fake.events.filter((event) => event.kind === 'checkpoint').length, 2, '每轮一条 checkpoint');
});

test('预算：maxRounds 用尽 → blocked + budget-rounds（先检查预算再发请求）', async () => {
  const chat = fakeChat([{ text: '还要再查。', toolCalls: [call('c1', 'searchMessages')] }]);
  const fake = fakeStore();
  const result = await runAgent({ goal: 'g', chat, tools: stubTools(), store: fake.store, budget: { maxRounds: 1, maxToolCalls: 10 } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.stopReason, 'budget-rounds');
  assert.equal(chat.requests.length, 1, '预算耗尽后不能再调用模型');
  assert.deepEqual(fake.finishes.map((finish) => finish.status), ['blocked']);
});

test('预算：maxToolCalls 用尽 → blocked + budget-tool-calls，且不再执行后面的工具', async () => {
  let executed = 0;
  const tools = stubTools(() => { executed += 1; return { ok: true, value: {} }; });
  const chat = fakeChat([{ text: '', toolCalls: [call('c1', 'searchMessages'), call('c2', 'readSummary')] }]);
  const fake = fakeStore();
  const result = await runAgent({ goal: 'g', chat, tools, store: fake.store, budget: { maxRounds: 5, maxToolCalls: 1 } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.stopReason, 'budget-tool-calls');
  assert.equal(executed, 1, '超过上限的那次工具不能真的执行');
});

test('预算：maxUsd（需 costOf）超支 → blocked + budget-usd', async () => {
  const chat = fakeChat([{ text: '一次回答。', usage: { promptTokens: 100, completionTokens: 20 } }]);
  const fake = fakeStore();
  const result = await runAgent({
    goal: 'g', chat, tools: stubTools(), store: fake.store, budget: { ...budget, maxUsd: 0.5 },
    costOf: () => 0.8,
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.stopReason, 'budget-usd');
  assert.equal(result.usd, 0.8);
});

test('取消：signal 已 abort → 不调用模型，finish cancelled', async () => {
  const chat = fakeChat([{ text: '不该被调用' }]);
  const fake = fakeStore();
  const controller = new AbortController();
  controller.abort();
  const result = await runAgent({ goal: 'g', chat, tools: stubTools(), store: fake.store, budget, signal: controller.signal });
  assert.equal(result.status, 'cancelled');
  assert.equal(chat.requests.length, 0);
  assert.deepEqual(fake.finishes.map((finish) => finish.status), ['cancelled']);
});

test('取消：模型返回 aborted → finish cancelled（保留已收到内容）', async () => {
  const chat = fakeChat([{ text: '半截', aborted: true }]);
  const fake = fakeStore();
  const result = await runAgent({ goal: 'g', chat, tools: stubTools(), store: fake.store, budget });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.text, '');
});

test('错误：chat.reply 抛错 → failed，并写 error 事件（不静默）', async () => {
  const chat: AgentChatClient = { async reply() { throw new Error('网络断了'); } };
  const fake = fakeStore();
  const result = await runAgent({ goal: 'g', chat, tools: stubTools(), store: fake.store, budget });
  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason, 'error');
  assert.deepEqual(fake.finishes.map((finish) => finish.status), ['failed']);
  const error = fake.events.find((event) => event.kind === 'error');
  assert.match(JSON.stringify(error?.data), /网络断了/);
});

test('guard 工具默认拒绝 → blocked + guard-blocked（提案不能被偷偷创建）', async () => {
  const tools = stubTools(() => ({ ok: false, error: { code: 'tier-blocked', message: '需要审批' } }));
  const chat = fakeChat([
    { text: '', toolCalls: [call('c1', 'proposeLorebookPatch', { summary: 'x', patch: 'y' })] },
    { text: '算了' },
  ]);
  const fake = fakeStore();
  const result = await runAgent({ goal: 'g', chat, tools, store: fake.store, budget });
  assert.equal(result.status, 'blocked');
  assert.equal(result.stopReason, 'guard-blocked');
});

test('恢复：从 checkpoint 继续，不重复 startRun、不重放已执行工具', async () => {
  const checkpoint: AgentCheckpoint = {
    messages: [
      { role: 'user', content: '看看这段' },
      { role: 'assistant', content: '我先查一下。', toolCalls: [call('c1', 'searchMessages')] },
      { role: 'tool', toolCallId: 'c1', name: 'searchMessages', content: '{"ok":true}' },
    ],
    rounds: 1, toolCalls: 1, usd: 0, executedTools: ['searchMessages'],
  };
  const chat = fakeChat([{ text: '查完了，没问题。' }]);
  const fake = fakeStore(checkpoint);
  const result = await resumeAgent({ runId: 'r1', goal: '看看这段', chat, tools: stubTools(), store: fake.store, budget });
  assert.equal(result.status, 'done');
  assert.equal(result.rounds, 2, '从 checkpoint 的轮次继续累计');
  assert.equal(result.toolCalls, 1, '不重放已执行的工具');
  assert.equal(fake.starts.length, 0, '恢复不能重新 start');
  assert.deepEqual(chat.requests[0]?.messages, checkpoint.messages);
  assert.deepEqual(fake.finishes.map((finish) => finish.status), ['done']);
});

test('恢复：没有 checkpoint → failed + no-checkpoint（不假装从头开始）', async () => {
  const chat = fakeChat([{ text: '不该被调用' }]);
  const fake = fakeStore(undefined);
  const result = await resumeAgent({ runId: 'missing', goal: 'g', chat, tools: stubTools(), store: fake.store, budget });
  assert.equal(result.status, 'failed');
  assert.equal(result.stopReason, 'no-checkpoint');
  assert.equal(chat.requests.length, 0);
});
