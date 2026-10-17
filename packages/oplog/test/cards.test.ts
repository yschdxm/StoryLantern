import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import {
  cardDelete,
  cardUpsert,
  clampStateDelta,
  deriveRuntime,
  freezeSnapshot,
  liveCard,
  liveStash,
  listCards,
  listPacks,
  packUpsert,
  runtimePatch,
  sessionSetup,
  setupOf,
  stashUpsert,
  type Op,
} from '../src/index.ts';
import { Materializer } from '../src/materialize.ts';
import type { CharacterCard } from '../../cards/src/index.ts';

/**
 * 卡片模型（ADR-0011）的五条不变量：
 *  1. 卡片是**整文档 LWW + 墓碑**，与旧角色卡同一套收敛语义；
 *  2. 同一个 opId 重复应用结果不变（at-least-once 投递）；
 *  3. 运行时是**补丁序列**，按 HLC 全序重放，乱序到达也收敛；
 *  4. 并发增量（好感 +5 / +10）不会被覆盖掉；
 *  5. 两张副本最终 `freezeSnapshot` 相同（含卡片、开局配置、补丁、世界包、草稿）。
 */

function base(deviceId: string, t = 1_700_000_000_000) {
  return { deviceId, clock: new HlcClock({ now: () => t }) };
}

function characterCard(id: string, name: string, overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    card_type: 'character',
    meta: {
      id,
      schema: 'rolecard/v1',
      name,
      version: '1.0.0',
      language: 'zh-CN',
      rating: 'general',
      description: '',
    },
    identity: { name, background: '' },
    persona: { summary: '', traits: [], knowledge_boundary: '', ability_boundary: '' },
    speech: { style: '' },
    ...overrides,
  };
}

function setupOfSession() {
  return {
    characters: ['c1'],
    premise: '雨夜边境酒馆',
    opening_mode: 'auto' as const,
    origin: 'user' as const,
  };
}

test('卡片：写入后可查到，读接口不含墓碑', () => {
  const m = new Materializer();
  m.apply(cardUpsert(base('A'), { card: characterCard('c1', '星野') }));
  assert.equal(listCards(m.state).length, 1);
  assert.equal(liveCard(m.state, 'c1')?.card.meta.name, '星野');

  const remove = cardDelete(base('A', 1_700_000_100_000), { card_id: 'c1' });
  m.apply(remove);
  assert.equal(listCards(m.state).length, 0);
  assert.equal(liveCard(m.state, 'c1'), undefined);
});

test('卡片：同一个 opId 重复应用结果不变', () => {
  const op = cardUpsert(base('A'), { card: characterCard('c1', '星野') });
  const m = new Materializer();
  assert.equal(m.apply(op), 'applied');
  assert.equal(m.apply(op), 'duplicate');
  assert.equal(listCards(m.state).length, 1);
  assert.equal(m.appliedCount, 1);
});

test('卡片：乱序到达收敛（HLC 大的整份胜出）', () => {
  const early = cardUpsert(base('A', 1_700_000_000_000), {
    card: characterCard('c1', '旧名字', { identity: { name: '旧名字', background: '旧背景' } }),
  });
  const late = cardUpsert(base('B', 1_700_000_100_000), {
    card: characterCard('c1', '新名字', { identity: { name: '新名字', background: '新背景' } }),
  });

  const forward = new Materializer();
  forward.applyAll([early, late]);
  const backward = new Materializer();
  backward.applyAll([late, early]);

  assert.equal(liveCard(forward.state, 'c1')?.card.meta.name, '新名字');
  assert.equal(liveCard(backward.state, 'c1')?.card.meta.name, '新名字');
  assert.equal(freezeSnapshot(forward.snapshot()), freezeSnapshot(backward.snapshot()));
});

test('卡片：墓碑共用时间线（更旧的写入不会复活，更新的写入可以复活）', () => {
  const m = new Materializer();
  m.apply(cardUpsert(base('A', 1_700_000_000_000), { card: characterCard('c1', '星野') }));
  m.apply(cardDelete(base('A', 1_700_000_100_000), { card_id: 'c1' }));
  // 更旧的 upsert 到达：必须被墓碑挡住
  m.apply(cardUpsert(base('B', 1_700_000_050_000), { card: characterCard('c1', '旧写入') }));
  assert.equal(liveCard(m.state, 'c1'), undefined);

  // 更新的 upsert：复活，且保留最初的创建时间
  m.apply(cardUpsert(base('C', 1_700_000_200_000), { card: characterCard('c1', '新星野') }));
  const record = m.state.cards['c1'];
  assert.equal(record?.card.meta.name, '新星野');
  assert.equal(record?.createdHlc.t, 1_700_000_000_000);
});

test('卡片：删掉一张从没见过的卡也留下墓碑（防对端复活）', () => {
  const m = new Materializer();
  m.apply(cardDelete(base('A', 1_700_000_100_000), { card_id: 'ghost' }));
  m.apply(cardUpsert(base('B', 1_700_000_000_000), { card: characterCard('ghost', '更旧的卡') }));
  assert.equal(liveCard(m.state, 'ghost'), undefined);
});

test('开局配置：后写覆盖先写，且与卡片互不影响', () => {
  const m = new Materializer();
  m.apply(sessionSetup(base('A', 1_700_000_000_000), { session_id: 's1', setup: setupOfSession() }));
  m.apply(
    sessionSetup(base('B', 1_700_000_000_500), {
      session_id: 's1',
      setup: { ...setupOfSession(), premise: '晴天码头' },
    }),
  );
  assert.equal(setupOf(m.state, 's1')?.setup.premise, '晴天码头');
});

test('运行时：两台设备并发加好感，增量不丢（补丁而非覆盖）', () => {
  const m = new Materializer();
  const card = characterCard('c1', '星野', {
    state: {
      schema: { affection: { type: 'integer', default: 0, min: 0, max: 100 } },
      update_policy: { allow_llm_patch: true, require_engine_validation: true, max_delta_per_turn: 10 },
    },
  });
  m.apply(cardUpsert(base('A'), { card }));
  m.apply(sessionSetup(base('A'), { session_id: 's1', setup: setupOfSession() }));
  m.apply(
    runtimePatch(base('A', 1_700_000_001_000), {
      session_id: 's1',
      source: 'llm',
      deltas: [{ kind: 'state', scope: { kind: 'character', id: 'c1' }, name: 'affection', op: 'add', value: 5 }],
    }),
  );
  m.apply(
    runtimePatch(base('B', 1_700_000_002_000), {
      session_id: 's1',
      source: 'llm',
      deltas: [{ kind: 'state', scope: { kind: 'character', id: 'c1' }, name: 'affection', op: 'add', value: 10 }],
    }),
  );
  assert.equal(deriveRuntime(m.state, 's1').variables['character:c1']?.['affection'], 15);
});

test('运行时：补丁乱序到达，推导结果一致', () => {
  const card = characterCard('c1', '星野', {
    state: {
      schema: { affection: { type: 'integer', default: 0 } },
      update_policy: { allow_llm_patch: true, require_engine_validation: true },
    },
  });
  const setupOp = sessionSetup(base('A'), { session_id: 's1', setup: setupOfSession() });
  const add = (t: number, value: number): Op =>
    runtimePatch(base('A', t), {
      session_id: 's1',
      source: 'llm',
      deltas: [{ kind: 'state', scope: { kind: 'character', id: 'c1' }, name: 'affection', op: 'add', value }],
    });

  const ops = [cardUpsert(base('A'), { card }), setupOp, add(1_700_000_001_000, 3), add(1_700_000_002_000, 4)];
  const forward = new Materializer();
  forward.applyAll(ops);
  const shuffled = new Materializer();
  shuffled.applyAll([ops[3]!, ops[1]!, ops[0]!, ops[2]!]);

  assert.equal(deriveRuntime(forward.state, 's1').variables['character:c1']?.['affection'], 7);
  assert.deepEqual(deriveRuntime(shuffled.state, 's1'), deriveRuntime(forward.state, 's1'));
});

test('运行时：物品实例 grant/update/consume 有明确生命周期', () => {
  const m = new Materializer();
  m.apply(sessionSetup(base('A'), { session_id: 's1', setup: setupOfSession() }));
  m.apply(
    runtimePatch(base('A', 1_700_000_001_000), {
      session_id: 's1',
      source: 'engine',
      deltas: [
        {
          kind: 'item',
          action: 'grant',
          instance: { instance_id: 'i1', item_id: 'sword', holder: 'c1', condition: { durability: 100 } },
        },
      ],
    }),
  );
  m.apply(
    runtimePatch(base('A', 1_700_000_002_000), {
      session_id: 's1',
      source: 'user',
      deltas: [{ kind: 'item', action: 'update', instance_id: 'i1', holder: 'c2', condition: { durability: 80 } }],
    }),
  );
  let runtime = deriveRuntime(m.state, 's1');
  assert.equal(runtime.items['i1']?.holder, 'c2');
  assert.equal(runtime.items['i1']?.condition?.['durability'], 80);

  m.apply(
    runtimePatch(base('A', 1_700_000_003_000), {
      session_id: 's1',
      source: 'user',
      deltas: [{ kind: 'item', action: 'consume', instance_id: 'i1' }],
    }),
  );
  runtime = deriveRuntime(m.state, 's1');
  assert.equal(runtime.items['i1'], undefined);
});

test('运行时：场景切换记住当前舞台，局部状态可被 null 删除', () => {
  const m = new Materializer();
  m.apply(sessionSetup(base('A'), { session_id: 's1', setup: setupOfSession() }));
  m.apply(
    runtimePatch(base('A', 1_700_000_001_000), {
      session_id: 's1',
      source: 'engine',
      deltas: [{ kind: 'scene', scene_id: 'tavern', state: { weather: '暴雨', tension: '低' } }],
    }),
  );
  m.apply(
    runtimePatch(base('A', 1_700_000_002_000), {
      session_id: 's1',
      source: 'engine',
      deltas: [{ kind: 'scene', scene_id: 'tavern', state: { tension: '高', weather: null } }],
    }),
  );
  const runtime = deriveRuntime(m.state, 's1');
  assert.equal(runtime.current_scene_id, 'tavern');
  assert.deepEqual(runtime.scene_state['tavern'], { tension: '高' });
});

test('运行时：生产者侧夹取增量（min/max + 单回合上限），重放不再改变数值', () => {
  assert.deepEqual(clampStateDelta({ current: 95, delta: 40, min: 0, max: 100, maxDeltaPerTurn: 10 }), {
    value: 5,
    clamped: true,
  });
  assert.deepEqual(clampStateDelta({ current: 50, delta: 5, min: 0, max: 100, maxDeltaPerTurn: 10 }), {
    value: 5,
    clamped: false,
  });
  // 单回合上限先夹，再被 max 夹：95+10→100，实际增量 5
  assert.deepEqual(clampStateDelta({ current: 95, delta: 10, min: 0, max: 100, maxDeltaPerTurn: 10 }), {
    value: 5,
    clamped: true,
  });
});

test('世界包与兼容草稿：最小结构可用', () => {
  const m = new Materializer();
  m.apply(
    packUpsert(base('A'), {
      pack: {
        schema: 'worldpack/v1',
        id: 'p1',
        name: '边境城',
        version: '1.0.0',
        language: 'zh-CN',
        card_ids: ['c1'],
      },
    }),
  );
  assert.equal(listPacks(m.state).length, 1);

  m.apply(
    stashUpsert(base('A'), {
      entry: {
        schema: 'stash/v1',
        id: 'stash1',
        character_id: 'c1',
        kind: 'scenario',
        text: '雨夜酒馆',
        created_at: 1,
      },
    }),
  );
  assert.equal(liveStash(m.state).length, 1);
});

test('旧快照兼容：缺卡片模型那几张表的状态照样能装进物化器', () => {
  const legacyState = {
    characters: {},
    sessions: {},
    messages: {},
    lorebooks: {},
    memories: {},
    summaries: {},
    facts: {},
    settings: {},
  };
  const m = new Materializer({ version: 1, state: legacyState as never, appliedOpIds: [] });
  // 不崩、且新表为空
  assert.deepEqual(listCards(m.state), []);
  assert.deepEqual(deriveRuntime(m.state, 's1').variables, { session: {} });
  // 旧表的数据仍在
  m.apply(cardUpsert(base('A'), { card: characterCard('c1', '星野') }));
  assert.equal(listCards(m.state).length, 1);
});
