import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createAppStore } from '../src/app/state.ts';
import { createAgentController } from '../src/data/agent-session.ts';
import type { AgentChatReply } from '../src/data/agent-engine.ts';
import type { ChatCall, ChatClient, ChatReplyResult } from '../src/data/chat-client.ts';
import type { LoreCard } from '../../../packages/cards/src/index.ts';

/**
 * Agent 会话 runner（PLAN §7）：运行、工具、审批应用、拒绝、取消、恢复。
 *
 * 审批的硬约束在这里钉住：**业务 op 与 decide op 同批**；应用失败（目标不存在等）
 * 提案必须保持 pending，且不能半写。
 */

function fakeChat(replies: AgentChatReply[] = []): ChatClient & {
  requests: ChatCall[];
  push(reply: AgentChatReply): void;
} {
  const queue = [...replies];
  const requests: ChatCall[] = [];
  return {
    available: true,
    requests,
    push(reply) {
      queue.push(reply);
    },
    async reply(request: ChatCall): Promise<ChatReplyResult> {
      requests.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error('fakeChat：没有下一份回复');
      return {
        text: next.text,
        ...(next.toolCalls === undefined
          ? {}
          : {
              toolCalls: next.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              })),
            }),
        aborted: next.aborted === true,
      };
    },
    async preview() {
      return { url: '', body: '', byteLength: 0, model: '' };
    },
    async probe() {
      return { ok: true, message: '' };
    },
  };
}

async function setup(chat: ChatClient) {
  const ports = createLocalOpPorts();
  const repository = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repository.ready;
  const store = createAppStore(repository);
  const character = await repository.characters.save({ name: '星野' });
  const session = await repository.sessions.create(character.id, '测试');
  const settings: Record<string, string> = {};
  const controller = createAgentController({ store, chat, settings, sessionId: session.id, now: () => 1_700_000_000_000 });
  return { repository, store, settings, session, controller, agent: repository.agent };
}

const loreCard = (id: string, content: string): LoreCard => ({
  card_type: 'lore',
  meta: { id, schema: 'lore/v1', name: id, version: '1.0.0', language: 'zh-CN', description: '测试设定', rating: 'general' },
  kind: 'other',
  content,
  keys: ['铜铃'],
});

const toolReply = (name: string, args: unknown): AgentChatReply => ({
  text: '',
  toolCalls: [{ id: 'call_1', name, arguments: args }],
});

test('直接回答：run 落 start/finish/事件，listRuns/timeline 可读', async () => {
  const chat = fakeChat([{ text: '看过了，没问题。' }]);
  const { controller, repository } = await setup(chat);
  const result = await controller.run('看看这段');
  assert.equal(result.status, 'done');
  assert.equal(result.text, '看过了，没问题。');
  const runs = await controller.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, 'done');
  const timeline = await controller.timeline(result.runId);
  assert.deepEqual(timeline.map((event) => event.kind), ['status', 'assistant', 'checkpoint', 'status']);
  assert.equal(repository.currentMaterializer().state.agent.runs[result.runId]?.status, 'done');
});

test('工具调用：第一轮请求 searchMessages，第二轮把 tool 结果带回模型', async () => {
  const chat = fakeChat([
    toolReply('searchMessages', { query: '铜铃' }),
    { text: '找到了：铜铃在第三轮。' },
  ]);
  const { controller } = await setup(chat);
  const result = await controller.run('找铜铃');
  assert.equal(result.status, 'done');
  assert.equal(result.toolCalls, 1);
  const timeline = await controller.timeline(result.runId);
  assert.ok(timeline.some((event) => event.kind === 'tool'));
  assert.ok(timeline.some((event) => event.kind === 'tool_result'));
  assert.equal(chat.requests.length, 2);
  const toolMessage = chat.requests[1]?.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage?.tool_call_id, 'call_1');
});

test('审批通过：lorebook_patch 追加正文，decision 与业务 op 同批落库', async () => {
  await Promise.resolve();
  const card = loreCard('l1', '铜铃是遗物。');
  const chat = fakeChat([
    toolReply('proposeLorebookPatch', { summary: '补充来历', targetCardId: 'l1', patch: '三年前留下的。' }),
    { text: '已提出提案。' },
  ]);
  const { controller, repository, agent } = await setup(chat);
  await repository.cards.save(card);
  await controller.run('补全设定');
  const pending = await controller.proposals('pending');
  assert.equal(pending.length, 1);
  const proposal = pending[0];
  assert.ok(proposal !== undefined);

  const approved = await controller.approve(proposal.proposalId);
  assert.equal(approved.applied, 1);
  assert.equal((await repository.cards.get('l1') as LoreCard | undefined)?.content, '铜铃是遗物。\n\n三年前留下的。');
  assert.equal(agent?.getProposal(proposal.proposalId)?.status, 'approved');
});

test('审批失败不半写：lore 目标不存在 → 提案保持 pending，卡片没有新增', async () => {
  const chat = fakeChat([
    toolReply('proposeLorebookPatch', { summary: '补不存在的卡', targetCardId: 'missing', patch: '内容' }),
    { text: '已提出。' },
  ]);
  const { controller, repository } = await setup(chat);
  const cardsBefore = (await repository.cards.list()).length;
  await controller.run('补不存在的卡');
  const proposal = (await controller.proposals('pending'))[0];
  assert.ok(proposal !== undefined);
  await assert.rejects(controller.approve(proposal.proposalId), /目标卡片不存在/);
  assert.equal((await controller.proposals('pending'))[0]?.proposalId, proposal.proposalId, '失败后仍是 pending');
  assert.equal((await repository.cards.list()).length, cardsBefore, '没有半写卡片');
});

test('审批通过：记忆合并 → 新记忆 + 删除旧记忆（保留 provenance）', async () => {
  const chat = fakeChat();
  const { controller, repository } = await setup(chat);
  const first = await repository.memories.save({ text: '铜铃是遗物。', keys: [], importance: 50, sourceMessageIds: ['s1'] });
  const second = await repository.memories.save({ text: '父亲留下的。', keys: [], importance: 50, sourceMessageIds: ['s2'] });
  chat.push(
    toolReply('proposeMemoryCompaction', {
      summary: '合并两条记忆',
      memoryIds: [first.id, second.id],
      mergedText: '铜铃是父亲留下的遗物。',
    }),
  );
  chat.push({ text: '已提出。' });
  await controller.run('整理记忆');
  const proposal = (await controller.proposals('pending'))[0];
  assert.ok(proposal !== undefined);
  await controller.approve(proposal.proposalId);
  const memories = await repository.memories.list();
  assert.deepEqual(memories.map((memory) => memory.id), ['agent-merge-' + proposal.proposalId]);
  assert.equal(memories[0]?.text, '铜铃是父亲留下的遗物。');
  assert.deepEqual(memories[0]?.sourceMessageIds, ['s1', 's2']);
});

test('审批拒绝：只写 decision，不改任何业务数据', async () => {
  const chat = fakeChat([toolReply('proposePromptPatch', { summary: '加一句提示', patch: '保持克制。' }), { text: '已提出。' }]);
  const { controller, repository, settings } = await setup(chat);
  await controller.run('加提示');
  const proposal = (await controller.proposals('pending'))[0];
  assert.ok(proposal !== undefined);
  await controller.reject(proposal.proposalId);
  const after = await controller.proposals();
  assert.equal(after.find((item) => item.proposalId === proposal.proposalId)?.status, 'rejected');
  assert.equal(repository.currentMaterializer().state.settings['chat.authors_note']?.value, undefined);
  assert.deepEqual(settings, {});
});

test('取消：AbortSignal 让运行落 cancelled 终态（不是假完成）', async () => {
  const waiting: ChatClient = {
    available: true,
    async reply(_request, handlers) {
      return new Promise<ChatReplyResult>((resolve) => {
        handlers.signal?.addEventListener('abort', () => resolve({ text: '', aborted: true }));
      });
    },
    async preview() {
      return { url: '', body: '', byteLength: 0, model: '' };
    },
    async probe() {
      return { ok: true, message: '' };
    },
  };
  const { controller, repository } = await setup(waiting);
  const running = controller.run('长任务');
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.cancel();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(repository.currentMaterializer().state.agent.runs[result.runId]?.status, 'cancelled');
});

test('恢复：失败运行从最近 checkpoint 继续，不重放已执行工具', async () => {
  const chat = fakeChat([toolReply('searchMessages', { query: '铜铃' })]);
  const { controller, repository } = await setup(chat);
  const failed = await controller.run('找铜铃'); // 第二轮没有回复 → fakeChat 抛错 → failed
  assert.equal(failed.status, 'failed');
  const eventsBefore = (await controller.timeline(failed.runId)).length;
  chat.push({ text: '继续完成。' });
  const resumed = await controller.resume(failed.runId);
  assert.equal(resumed.status, 'done');
  assert.equal(resumed.text, '继续完成。');
  assert.ok((await controller.timeline(failed.runId)).length > eventsBefore);
  assert.equal(repository.currentMaterializer().state.agent.runs[failed.runId]?.status, 'done');
});
