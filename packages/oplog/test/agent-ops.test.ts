import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Materializer,
  agentOps,
  agentProposalOf,
  agentRunOf,
  applyAgentOp,
  isAgentOp,
  listAgentEvents,
  pendingAgentProposals,
  normalizeState,
} from '../src/index.ts';
import { HlcClock } from '../src/hlc.ts';

/**
 * Agent 层（PLAN §7）op/投影：
 *  - 五个 op 都要可重放、可收敛（乱序/重复投递不改变结果）；
 *  - 事件只追加，同 eventId 幂等；
 *  - run/proposal 的状态用 LWW，旧 finish/decision 不能盖掉新的；
 *  - 快照与旧日志兼容（旧状态没有 agent 表 → 补空，不崩）。
 */

function base(deviceId: string, t = 1_700_000_000_000) {
  return { deviceId, clock: new HlcClock({ now: () => t }) };
}

const budget = { maxRounds: 4, maxToolCalls: 6, maxUsd: 0.25 };

test('agent.run.start：投影出 running、goal/budget/绑定会话都保留', () => {
  const m = new Materializer();
  m.apply(agentOps.runStart(base('A'), {
    runId: 'r1', sessionId: 's1', goal: '整理这段记忆', modelProfileId: 'p1', budget, createdAt: 1000,
  }));
  const run = agentRunOf(m.state, 'r1');
  assert.equal(run?.status, 'running');
  assert.equal(run?.goal, '整理这段记忆');
  assert.equal(run?.sessionId, 's1');
  assert.equal(run?.budget.maxToolCalls, 6);
  assert.equal(run?.createdAt, 1000);
});

test('agent.event.append：按 HLC 排序、同 eventId 幂等、先于 run.start 到达也不丢', () => {
  const m = new Materializer();
  // 事件先到（同步乱序）：不能当孤儿丢掉
  m.apply(agentOps.eventAppend(base('A', 1_700_000_000_500), {
    runId: 'r1', eventId: 'e2', kind: 'assistant', data: { text: '第二' }, at: 2,
  }));
  m.apply(agentOps.runStart(base('A', 1_700_000_000_000), {
    runId: 'r1', goal: 'g', budget, createdAt: 1,
  }));
  m.apply(agentOps.eventAppend(base('A', 1_700_000_000_100), {
    runId: 'r1', eventId: 'e1', kind: 'status', data: { phase: 'start' }, at: 1,
  }));
  // 重复投递同一条：不新增
  m.apply(agentOps.eventAppend(base('A', 1_700_000_000_900), {
    runId: 'r1', eventId: 'e1', kind: 'status', data: { phase: 'start' }, at: 1,
  }));
  assert.deepEqual(listAgentEvents(m.state, 'r1').map((event) => event.eventId), ['e1', 'e2']);
  assert.equal(listAgentEvents(m.state, 'missing').length, 0);
});

test('agent.proposal.create/decide：pending → approved/rejected；旧决定不覆盖新决定', () => {
  const m = new Materializer();
  m.apply(agentOps.proposalCreate(base('A', 1_700_000_000_000), {
    proposalId: 'p1', runId: 'r1', kind: 'memory_compaction', summary: '合并两条近重复记忆', payload: { ids: ['m1', 'm2'] }, status: 'pending',
  }));
  assert.equal(agentProposalOf(m.state, 'p1')?.status, 'pending');
  assert.deepEqual(pendingAgentProposals(m.state).map((proposal) => proposal.proposalId), ['p1']);

  m.apply(agentOps.proposalDecide(base('A', 1_700_000_000_100), { proposalId: 'p1', decision: 'approved', at: 10 }));
  assert.equal(agentProposalOf(m.state, 'p1')?.status, 'approved');
  assert.equal(pendingAgentProposals(m.state).length, 0);

  // 同 HLC 更小的 opId 不能翻案；更晚的 rejected 生效
  m.apply(agentOps.proposalDecide(base('A', 1_700_000_000_050), { proposalId: 'p1', decision: 'rejected', at: 5 }));
  assert.equal(agentProposalOf(m.state, 'p1')?.status, 'approved', '旧的拒绝不能盖掉新的批准');
  m.apply(agentOps.proposalDecide(base('A', 1_700_000_000_200), { proposalId: 'p1', decision: 'rejected', at: 20 }));
  assert.equal(agentProposalOf(m.state, 'p1')?.status, 'rejected');
});

test('agent.proposal.decide 没有 create 时是 orphan（依赖没到，不能假装已决定）', () => {
  const m = new Materializer();
  const result = m.apply(agentOps.proposalDecide(base('A'), { proposalId: 'missing', decision: 'approved', at: 1 }));
  assert.equal(result, 'orphan');
  assert.equal(m.orphanCount, 1);
});

test('agent.run.finish：终态 LWW；先 finish 后 start 的旧 finish 被忽略', () => {
  const m = new Materializer();
  m.apply(agentOps.runStart(base('A', 1_700_000_000_000), { runId: 'r1', goal: 'g', budget, createdAt: 1 }));
  m.apply(agentOps.runFinish(base('A', 1_700_000_000_100), { runId: 'r1', status: 'done', at: 10 }));
  assert.equal(agentRunOf(m.state, 'r1')?.status, 'done');
  m.apply(agentOps.runFinish(base('A', 1_700_000_000_050), { runId: 'r1', status: 'failed', at: 5 }));
  assert.equal(agentRunOf(m.state, 'r1')?.status, 'done', '旧的 failed 不能盖掉新的 done');
  assert.equal(agentRunOf(m.state, 'r1')?.finishedAt, 10);
});

test('agent.run.finish 没有 start 时是 orphan；isAgentOp 只认五个 op', () => {
  const m = new Materializer();
  assert.equal(m.apply(agentOps.runFinish(base('A'), { runId: 'missing', status: 'done', at: 1 })), 'orphan');
  for (const type of ['agent.run.start', 'agent.event.append', 'agent.proposal.create', 'agent.proposal.decide', 'agent.run.finish']) {
    assert.equal(isAgentOp(type), true, type);
  }
  assert.equal(isAgentOp('message.append'), false);
  assert.equal(isAgentOp('agent.unknown'), false);
});

test('快照往返保留 agent 状态；旧快照（没有 agent 表）由 normalizeState 补空', () => {
  const m = new Materializer();
  m.apply(agentOps.runStart(base('A'), { runId: 'r1', goal: 'g', budget, createdAt: 1 }));
  m.apply(agentOps.eventAppend(base('A'), { runId: 'r1', eventId: 'e1', kind: 'checkpoint', data: { rounds: 1 }, at: 2 }));
  m.apply(agentOps.proposalCreate(base('A'), {
    proposalId: 'p1', runId: 'r1', kind: 'prompt_patch', summary: '微调语气', payload: { patch: '短句' }, status: 'pending',
  }));
  m.apply(agentOps.runFinish(base('A'), { runId: 'r1', status: 'done', at: 3 }));

  const restored = new Materializer(m.snapshot());
  assert.equal(agentRunOf(restored.state, 'r1')?.status, 'done');
  assert.equal(listAgentEvents(restored.state, 'r1').length, 1);
  assert.equal(agentProposalOf(restored.state, 'p1')?.status, 'pending');

  // 旧快照：整体状态里没有 agent 字段
  const legacy = normalizeState({});
  assert.deepEqual(legacy.agent, { runs: {}, proposals: {}, events: {} });
});

test('applyAgentOp 对未知类型不抛错（向前兼容）', () => {
  const m = new Materializer();
  const state = m.state;
  const result = applyAgentOp(state, { type: 'agent.future.op' } as never);
  assert.equal(result, 'applied');
  assert.deepEqual(state.agent, { runs: {}, proposals: {}, events: {} });
});
