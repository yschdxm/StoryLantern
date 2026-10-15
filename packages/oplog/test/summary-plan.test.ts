import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { Materializer } from '../src/materialize.ts';
import { listSummaries } from '../src/summary-projection.ts';
import {
  countUnits,
  planSummaries,
  staleSummaries,
  summaryIdOf,
  type SummaryMessage,
  type SummaryTarget,
} from '../src/summary-plan.ts';
import { summaryDelete, summaryUpsert } from '../src/summary-ops.ts';
import { nodeDigest } from '../src/node-adapters.ts';
import { toHex, utf8 } from '../src/bytes.ts';
import type { SummaryRecord } from '../src/state-types.ts';

/**
 * M4 判据的落点：**内容哈希幂等** 与 **编辑旧消息后受影响摘要 100% 失效重算**。
 *
 * 这里只测"计划器"（纯函数）+ 一次物化集成；真正去调模型生成摘要文本是调用方的事
 * （评估地基里已有回放式 provider，见 eval/long-chat）。
 */

const SESSION = '会话甲';
const SCENE = 4; // 测试里把窗口调小，看得清
const ARC = 2;

/** 确定性假指纹：够用就好（真指纹另有一条用例）。 */
const fakeHash = async (parts: readonly string[]): Promise<string> => parts.join('§');

function makeMessages(count: number, edit?: { at: number; content: string }): SummaryMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `M${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: edit !== undefined && index + 1 === edit.at ? edit.content : `第 ${index + 1} 条。`,
  }));
}

/** 用物化器把"已存在的摘要"造出来（走真实 op → 物化路径）。 */
function withExisting(targets: Awaited<ReturnType<typeof planSummaries>>): {
  records: SummaryRecord[];
  materializer: Materializer;
  clock: HlcClock;
} {
  const materializer = new Materializer();
  const clock = new HlcClock();
  for (const target of targets) {
    materializer.apply(
      summaryUpsert(
        { deviceId: 'device-a', clock },
        {
          summaryId: target.summaryId,
          sessionId: target.sessionId,
          level: target.level,
          covers: target.covers,
          contentHash: target.contentHash,
          text: `摘要（${target.level}）：${target.covers.join(',')}`,
          createdBy: 'model',
          modelId: 'mock',
        },
      ),
    );
  }
  return { records: Object.values(materializer.state.summaries), materializer, clock };
}

function plan(messages: SummaryMessage[], existing: readonly SummaryRecord[], hash = fakeHash): Promise<SummaryTarget[]> {
  return planSummaries({ sessionId: SESSION, messages, existing, hash, sceneSize: SCENE, arcSize: ARC });
}

test('分层结构：scene/arc/session 按窗口切，只有攒满的单元才成摘要', async () => {
  const messages = makeMessages(SCENE * 4 + 1); // 4 个满 scene + 1 条尾巴
  const targets = await plan(messages, []);
  const scenes = targets.filter((target) => target.level === 'scene');
  const arcs = targets.filter((target) => target.level === 'arc');
  const sessions = targets.filter((target) => target.level === 'session');
  console.log(`  分层：${messages.length} 条消息 → scene ${scenes.length} / arc ${arcs.length} / session ${sessions.length}`);
  assert.equal(scenes.length, 4, '只有攒满的 scene 才算单元（尾巴 1 条不算）');
  assert.equal(arcs.length, 2, `${ARC} 个 scene 一个 arc`);
  assert.equal(sessions.length, 1, `${ARC} 个 arc 一个 session`);
  assert.ok(targets.every((target) => target.reason === 'missing'));
});

test('防漂移：countUnits 与 planSummaries 必须给出同一个单元数', async () => {
  for (const count of [0, 1, SCENE - 1, SCENE, SCENE * 3, SCENE * 3 + 1, SCENE * 8]) {
    const messages = makeMessages(count);
    const targets = await plan(messages, []);
    assert.equal(countUnits(count, SCENE, ARC), targets.length, `消息 ${count} 条时两者必须一致`);
  }
  console.log('  防漂移：0/1/3/4/12/13/32 条消息下 countUnits 与计划结果一致');
});

test('幂等：内容没变时再计划一次，什么都不用做（不写任何新 op）', async () => {
  const messages = makeMessages(SCENE * 3);
  const first = await plan(messages, []);
  assert.equal(first.length, 4); // 3 scene + 1 arc（2 个 scene 才成一个 arc → 只有 1 个）

  const { records } = withExisting(first);
  const second = await plan(messages, records);
  console.log(`  幂等：首次计划 ${first.length} 项，第二次 ${second.length} 项`);
  assert.deepEqual(second, [], '指纹一致 → 既不算 missing 也不算 stale');
});

test('失效传播：改一条消息，覆盖它的摘要**以及所有上层**都变 stale，无关的不动', async () => {
  const messages = makeMessages(SCENE * 2); // 2 个 scene → 1 个 arc → 0 个 session（ARC=2 需要 2 个 arc）
  const first = await plan(messages, []);
  const { records } = withExisting(first);
  assert.deepEqual(await plan(messages, records), [], '先确认基线是幂等的');

  // 改第 2 条（落在第 1 个 scene 里）
  const edited = makeMessages(SCENE * 2, { at: 2, content: '改过的第 2 条。' });
  const stale = await staleSummaries({ sessionId: SESSION, messages: edited, existing: records, hash: fakeHash, sceneSize: SCENE, arcSize: ARC });

  const staleIds = stale.map((target) => target.summaryId).sort();
  const firstScene = summaryIdOf(SESSION, 'scene', ['M1', 'M2', 'M3', 'M4']);
  const secondScene = summaryIdOf(SESSION, 'scene', ['M5', 'M6', 'M7', 'M8']);
  const arc = summaryIdOf(SESSION, 'arc', [firstScene, secondScene]);
  console.log(`  失效：${stale.length} 项 → ${stale.map((t) => t.level).join(', ')}`);
  assert.deepEqual(staleIds, [arc, firstScene].sort(), '受影响的是第 1 个 scene 与它所在的 arc，第 2 个 scene 不动');
  assert.ok(stale.every((target) => target.reason === 'stale'));
});

test('受影响摘要 100% 失效：逐个改每一条消息，覆盖它的摘要链条必须全部出现', async () => {
  const messages = makeMessages(SCENE * 3);
  const first = await plan(messages, []);
  const { records } = withExisting(first);

  let checked = 0;
  for (let at = 1; at <= messages.length; at += 1) {
    const edited = makeMessages(SCENE * 3, { at, content: `改过的第 ${at} 条。` });
    const staleIds = new Set(
      (await staleSummaries({ sessionId: SESSION, messages: edited, existing: records, hash: fakeHash, sceneSize: SCENE, arcSize: ARC })).map(
        (target) => target.summaryId,
      ),
    );
    // 期望：覆盖该消息的 scene + 它的父 arc + 父 session，全都要 stale
    for (const target of first) {
      const coversMessage = target.level === 'scene' ? target.covers.includes(`M${at}`) : target.covers.some((id) => staleIds.has(id) || id.includes(`M${at}`));
      if (!coversMessage) continue;
      assert.ok(staleIds.has(target.summaryId), `第 ${at} 条被改后，${target.level} ${target.summaryId} 必须失效`);
      checked += 1;
    }
  }
  console.log(`  100% 失效：共核对 ${checked} 组"消息 → 覆盖它的摘要"`);
  assert.ok(checked > 0);
});

test('删除优先：墓碑里的 id 不会被重新生成（哪怕内容没变）', async () => {
  const messages = makeMessages(SCENE * 2);
  const first = await plan(messages, []);
  const { records, materializer, clock } = withExisting(first);
  const victim = first.find((target) => target.level === 'scene');
  assert.ok(victim !== undefined);
  materializer.apply(
    summaryDelete({ deviceId: 'device-a', clock }, { summaryId: victim.summaryId }),
  );
  const afterDelete = Object.values(materializer.state.summaries);
  const targets = await plan(messages, afterDelete);
  assert.equal(targets.some((target) => target.summaryId === victim.summaryId), false, '删掉的摘要不该被重新计划出来');
});

test('真实 sha256 下同样成立：指纹变了才重算（用 nodeDigest 走一遍）', async () => {
  const realHash = async (parts: readonly string[]): Promise<string> => toHex(await nodeDigest.sha256(utf8(parts.join('\n'))));
  const messages = makeMessages(SCENE * 2);
  const first = await plan(messages, [], realHash);
  const { records } = withExisting(first);
  assert.deepEqual(await plan(messages, records, realHash), [], '真指纹下也要幂等');

  const edited = makeMessages(SCENE * 2, { at: 5, content: '改过的第 5 条。' });
  const stale = await staleSummaries({ sessionId: SESSION, messages: edited, existing: records, hash: realHash, sceneSize: SCENE, arcSize: ARC });
  console.log(`  真实 sha256：改第 5 条 → ${stale.length} 项 stale（${stale.map((t) => t.level).join(', ')}）`);
  assert.equal(stale.length, 2, '第 2 个 scene + 它的父 arc');
});

test('物化集成：summary.upsert 进物化器后能按会话/层级列出来，旧写入是 duplicate', async () => {
  const clock = new HlcClock();
  const materializer = new Materializer();
  const targets = await plan(makeMessages(SCENE), []);
  const target = targets[0];
  assert.ok(target !== undefined);

  const op = summaryUpsert(
    { deviceId: 'device-a', clock },
    {
      summaryId: target.summaryId,
      sessionId: target.sessionId,
      level: target.level,
      covers: target.covers,
      contentHash: target.contentHash,
      text: '第一段。',
      createdBy: 'model',
      modelId: 'mock',
    },
  );
  assert.equal(materializer.apply(op), 'applied');
  assert.equal(materializer.apply(op), 'duplicate', '同一条 op 再来一次应当是 duplicate');
  const listed = listSummaries(materializer.state, SESSION, 'scene');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.text, '第一段。');
  assert.equal(listed[0]?.contentHash, target.contentHash);
  assert.equal(materializer.state.summaries[target.summaryId]?.covers.length, SCENE);
});

test('消息的 role/content 都参与指纹：只改角色也算变', async () => {
  const messages = makeMessages(SCENE);
  const first = await plan(messages, []);
  const { records } = withExisting(first);
  const roleChanged = messages.map((message, index) => (index === 0 ? { ...message, role: 'assistant' } : message));
  const stale = await staleSummaries({ sessionId: SESSION, messages: roleChanged, existing: records, hash: fakeHash, sceneSize: SCENE, arcSize: ARC });
  assert.equal(stale.length, 1, '只改 role 也必须让这个 scene 失效');
});
