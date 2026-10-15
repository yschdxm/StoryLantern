import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { Materializer } from '../src/materialize.ts';
import { summaryDelete } from '../src/summary-ops.ts';
import { planSummaries, type SummaryMessage } from '../src/summary-plan.ts';
import { runSummaries, type SummarizeRequest } from '../src/summary-runner.ts';
import { toHex, utf8 } from '../src/bytes.ts';
import { nodeDigest } from '../src/node-adapters.ts';
import type { SummaryRecord } from '../src/state-types.ts';

/**
 * 摘要**执行器**：把计划器的目标真正生成出来，并证明循环会收敛。
 *
 * 这补上了上一轮明确留下的缺口——"计划器只说该写什么，没接生成"。
 * 生成用注入的桩（真机换成模型客户端、评估里换成回放客户端，本模块自己不碰网络）。
 */

const SESSION = '会话甲';
const SCENE = 4;
const ARC = 2;
const realHash = async (parts: readonly string[]): Promise<string> => toHex(await nodeDigest.sha256(utf8(parts.join('\n'))));

function makeMessages(count: number, edit?: { at: number; content: string }): SummaryMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `M${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: edit !== undefined && index + 1 === edit.at ? edit.content : `第 ${index + 1} 条。`,
  }));
}

/** 记录所有生成请求的桩：文本里带上输入，便于断言"父层看到的是本次的新文本"。 */
function makeSummarizer() {
  const requests: SummarizeRequest[] = [];
  const summarize = async (request: SummarizeRequest): Promise<string> => {
    requests.push({ ...request, inputs: [...request.inputs], covers: [...request.covers] });
    return `[${request.level}] ${request.inputs.join(' / ')}`;
  };
  return { requests, summarize };
}

function applyOps(state: Materializer, ops: Awaited<ReturnType<typeof runSummaries>>['ops']): void {
  for (const op of ops) state.apply(op);
}

const aliveOf = (state: Materializer): SummaryRecord[] => Object.values(state.state.summaries);

test('首次运行：自底向上生成，父层看到的是**本次**刚生成的子摘要文本', async () => {
  const messages = makeMessages(16); // 4 scene → 2 arc → 1 session
  const { requests, summarize } = makeSummarizer();
  const clock = new HlcClock();
  const result = await runSummaries({
    sessionId: SESSION,
    messages,
    existing: [],
    options: { deviceId: 'device-a', clock, hash: realHash, summarize, modelId: 'mock', sceneSize: SCENE, arcSize: ARC },
  });

  const levels = result.ops.map((op) => (op.payload as { level: string }).level);
  console.log(`  首次运行：${result.ops.length} 条 op，层级顺序 = ${levels.join(' → ')}`);
  assert.equal(result.ops.length, 7, '4 scene + 2 arc + 1 session');
  assert.deepEqual(levels, ['scene', 'scene', 'scene', 'scene', 'arc', 'arc', 'session'], '必须自底向上');

  // arc 的输入必须含"本次生成的 scene 文本"，而不是磁盘上的旧值
  const arcRequest = requests.find((request) => request.level === 'arc');
  assert.ok(arcRequest !== undefined);
  assert.ok(arcRequest.inputs.every((line) => line.startsWith('[scene]')), 'arc 的输入应当是摘要文本，不是原始消息');
  const sessionRequest = requests.find((request) => request.level === 'session');
  assert.ok(sessionRequest !== undefined);
  assert.ok(sessionRequest.inputs.every((line) => line.startsWith('[arc]')));
});

test('收敛：把 op 落库后再跑一次，什么都不用生成（幂等闭环）', async () => {
  const messages = makeMessages(16);
  const materializer = new Materializer();
  const clock = new HlcClock();
  const options = { deviceId: 'device-a', clock, hash: realHash, summarize: makeSummarizer().summarize, modelId: 'mock', sceneSize: SCENE, arcSize: ARC };

  const first = await runSummaries({ sessionId: SESSION, messages, existing: [], options });
  applyOps(materializer, first.ops);

  const second = await runSummaries({ sessionId: SESSION, messages, existing: aliveOf(materializer), options });
  console.log(`  收敛：首次 ${first.ops.length} 条 op → 第二次 ${second.ops.length} 条`);
  assert.equal(second.ops.length, 0, '指纹一致 → 不再生成任何 op');
  assert.equal(materializer.state.summaries && Object.keys(materializer.state.summaries).length, 7);
});

test('编辑一条消息：只重算受影响的链条（scene + 它的父 arc + 父 session）', async () => {
  const messages = makeMessages(16);
  const materializer = new Materializer();
  const clock = new HlcClock();
  const options = { deviceId: 'device-a', clock, hash: realHash, summarize: makeSummarizer().summarize, modelId: 'mock', sceneSize: SCENE, arcSize: ARC };
  applyOps(materializer, (await runSummaries({ sessionId: SESSION, messages, existing: [], options })).ops);

  // 改第 2 条（落在第 1 个 scene 里）
  const edited = makeMessages(16, { at: 2, content: '改过的第 2 条。' });
  const { requests, summarize } = makeSummarizer();
  const rerun = await runSummaries({
    sessionId: SESSION,
    messages: edited,
    existing: aliveOf(materializer),
    options: { ...options, summarize },
  });
  const levels = rerun.ops.map((op) => (op.payload as { level: string }).level);
  console.log(`  编辑后重算：${rerun.ops.length} 条（${levels.join(', ')}）`);
  assert.deepEqual(levels, ['scene', 'arc', 'session'], '受影响的 scene + 父 arc + 父 session，共 3 条');
  // scene 的输入里必须能看到改动后的内容
  const sceneRequest = requests.find((request) => request.level === 'scene');
  assert.ok(sceneRequest?.inputs.some((line) => line.includes('改过的第 2 条')));
  // 未受影响的 scene（第 2 个）不该被重算
  const rerunCovers = rerun.ops[0]?.payload as { covers: string[] };
  assert.deepEqual(rerunCovers.covers, ['M1', 'M2', 'M3', 'M4']);
});

test('删除优先：墓碑里的摘要不会被重新生成（即使内容没变）', async () => {
  const messages = makeMessages(16);
  const materializer = new Materializer();
  const clock = new HlcClock();
  const options = { deviceId: 'device-a', clock, hash: realHash, summarize: makeSummarizer().summarize, modelId: 'mock', sceneSize: SCENE, arcSize: ARC };
  applyOps(materializer, (await runSummaries({ sessionId: SESSION, messages, existing: [], options })).ops);

  const target = Object.values(materializer.state.summaries).find((record) => record.level === 'scene');
  assert.ok(target !== undefined);
  materializer.apply(summaryDelete({ deviceId: 'device-a', clock }, { summaryId: target.id }));

  const rerun = await runSummaries({ sessionId: SESSION, messages, existing: aliveOf(materializer), options });
  assert.equal(rerun.ops.some((op) => op.entity.id === target.id), false, '删掉的摘要不该被重新计划出来');
  console.log(`  删除优先：删掉 1 个 scene 后，重跑只生成 ${rerun.ops.length} 条（其中不含被删的那个）`);
});

test('计划器与执行器用的是同一个指纹：否则永远不会收敛（负向对照）', async () => {
  const messages = makeMessages(8);
  const clock = new HlcClock();
  const { summarize } = makeSummarizer();
  const materializer = new Materializer();

  // 用假指纹落库，再用真指纹去计划 → 永远算 stale（这就是"两个指纹不一致"的后果）
  const fakeHash = async (parts: readonly string[]): Promise<string> => parts.join('§');
  applyOps(materializer, (await runSummaries({ sessionId: SESSION, messages, existing: [], options: { deviceId: 'device-a', clock, hash: fakeHash, summarize, sceneSize: SCENE, arcSize: ARC } })).ops);

  const withReal = await planSummaries({ sessionId: SESSION, messages, existing: aliveOf(materializer), hash: realHash, sceneSize: SCENE, arcSize: ARC });
  console.log(`  负向对照：指纹不一致时，${withReal.length} 项永远算 stale`);
  assert.ok(withReal.length > 0, '指纹换成另一个 → 全部重新算 stale（这正是"必须共用同一个指纹"的理由）');
});
test('shouldContinue 返回 false 就停下：剩下的如实报出来，且不再调用模型', async () => {
  const messages = makeMessages(16); // 4 scene → 2 arc → 1 session = 7 个单元
  const clock = new HlcClock();
  const { requests, summarize } = makeSummarizer();
  let allowed = 2;
  const result = await runSummaries({
    sessionId: SESSION,
    messages,
    existing: [],
    options: {
      deviceId: 'device-a',
      clock,
      hash: realHash,
      summarize,
      sceneSize: SCENE,
      arcSize: ARC,
      shouldContinue: () => allowed-- > 0,
    },
  });
  console.log(`  中途停：做了 ${result.ops.length} 个单元，还剩 ${result.remaining} 个，模型被调用 ${requests.length} 次`);
  assert.equal(result.ops.length, 2, '只做两个单元');
  assert.equal(result.remaining, 5, '7 - 2 = 5');
  assert.equal(requests.length, 2, '停下之后不能再调用模型（否则就是白花钱）');
});
