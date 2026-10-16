import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HlcClock } from '../../../packages/oplog/src/hlc.ts';
import type { PluginContext } from '../../../packages/plugin-api/src/index.ts';
import type { TunerProposal } from '../../../packages/tuner/src/index.ts';
import { apply, type TunerAgent } from '../src/index.ts';

/**
 * M5 的第三条退出判据：**架构测试断言 Agent 不进入生成热路径**。
 *
 * 为什么要用"读源码断言"而不是只靠代码走查：ADR-0003 把"侧信道"写成了架构约定，
 * 而架构约定不写进测试就会在半年后被人情急之下破掉（"就在生成前顺手调一下 agent 嘛"）。
 * 这个测试就是那道闸：**生成路径的源码里不许出现 tuner**。
 *
 * 另外两条（0 条无审批写入、撤销逐字节还原）在 `packages/tuner/test/tuner.test.ts` 里；
 * 这里补一条**行为**断言：未批准时插件的 approve 必须抛错。
 */

/** 生成热路径：组装上下文与发起生成的地方。 */
const GENERATION_PATH = [
  'plugins/writing-pipeline/src/index.ts',
  'plugins/context-blocks/src/index.ts',
];

test('架构：生成热路径的源码里不许出现调优助手', () => {
  for (const file of GENERATION_PATH) {
    const source = readFileSync(file, 'utf8');
    assert.equal(/tuner|agent-sidecar/i.test(source), false, `${file} 不该引用调优助手（ADR-0003：它是侧信道）`);
  }
});

test('架构：调优插件里没有定时器/事件监听这类"自动应用"路径', () => {
  const source = readFileSync('plugins/tuner-agent/src/index.ts', 'utf8');
  assert.equal(/setInterval|setTimeout/.test(source), false, '不该有定时自动跑的分析');
  assert.equal(/ctx\.on\(/.test(source), false, '不该监听事件自动写入');
  assert.equal(/ctx\.effect\(/.test(source), false, '不该在生命周期里偷偷写入');
});

test('行为：未批准时 approve 必须拒绝（不是"默默不写"，而是明确抛错）', () => {
  const registered = new Map<string, unknown>();
  apply({ set: (key: string, value: unknown) => registered.set(key, value) } as unknown as PluginContext);
  const agent = registered.get('tuner.agent') as TunerAgent;
  assert.equal(typeof agent.propose, 'function');

  const clock = new HlcClock({ now: () => 1 });
  const proposal: TunerProposal = {
    id: 'x',
    kind: 'memory.merge',
    title: 't',
    reason: 'r',
    evidence: [],
    apply: { upserts: [], deletes: [] },
    inverse: { upserts: [], deletes: [] },
  };
  assert.throws(() => agent.approve(proposal, { deviceId: 'd', clock }, false), /必须经用户批准/);
  // 批准之后才产出 op（这里只断言"能产出"，具体语义在 tuner 包的测试里）
  const applied = agent.approve(proposal, { deviceId: 'd', clock }, true);
  assert.equal(Array.isArray(applied.ops), true);
  assert.equal(applied.ops.length, 1, '空提案也会留下一条账本 op（撤销依据）');
});
