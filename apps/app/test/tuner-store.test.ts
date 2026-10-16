import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../../../packages/oplog/src/hlc.ts';
import { Materializer } from '../../../packages/oplog/src/materialize.ts';
import { memoryUpsert } from '../../../packages/oplog/src/index.ts';
import { memoryContentProjection } from '../../../packages/tuner/src/index.ts';
import { createTunerStore } from '../src/data/op-tuner-store.ts';

/**
 * 界面走的那条路（应用侧仓储）：建议 → 应用 → 撤销。
 *
 * 为什么要单独测：`packages/tuner` 只保证"提案里没有 op、批准才造 op"；
 * **真正把 op 写下去的地方是这个仓储**，所以"只写一次、能撤销、陈旧建议拒绝"都得在这里断言。
 * 依赖只有四个动作（materializer / appendAndApply / base / withReady），因此不需要宿主、不需要网络。
 */

function makeStore() {
  let wall = 1_700_000_000_000;
  const clock = new HlcClock({ now: () => wall });
  const materializer = new Materializer();
  const base = { deviceId: 'dev-a', clock };
  const appends: number[] = [];

  materializer.applyAll([
    memoryUpsert(base, {
      memoryId: 'm1',
      text: '星野怕黑，睡觉时总要留一盏灯。',
      keys: [],
      importance: 50,
      sourceMessageIds: [],
      createdBy: 'user',
    }),
    memoryUpsert(base, {
      memoryId: 'm2',
      text: '星野怕黑，睡觉时必须留一盏灯。',
      keys: [],
      importance: 40,
      sourceMessageIds: [],
      createdBy: 'agent',
    }),
  ]);

  const store = createTunerStore({
    withReady: async (action) => action(),
    materializer: () => materializer,
    base: () => ({ deviceId: base.deviceId, clock }),
    appendAndApply: async (ops) => {
      appends.push(ops.length);
      materializer.applyAll(ops);
      wall += 1000;
    },
  });
  return { store, materializer, appends, base, advance: (ms = 1000) => { wall += ms; } };
}

test('建议阶段不写任何 op（应用侧仓储也一样），应用之后才写一次', async () => {
  const { store, appends } = makeStore();
  const suggestions = await store.suggest();
  assert.equal(suggestions.length, 1);
  assert.deepEqual(appends, [], '列建议不得写入');
  assert.equal(suggestions[0]?.evidence.length, 3, '建议要带证据（成员、相似度、合并规则）');

  const applied = await store.apply(suggestions[0]?.id ?? '');
  assert.deepEqual(applied, { ok: true });
  // 合并 = 1 条 upsert（新 id）+ 2 条 delete（两个成员）+ 1 条账本 op
  assert.deepEqual(appends, [4], '一次应用 = 合并 upsert + 两条成员 delete + 一条账本 op');
});

test('陈旧建议拒绝：状态变过之后，同一个 id 不许再写', async () => {
  const { store, materializer, appends, base, advance } = makeStore();
  const id = (await store.suggest())[0]?.id ?? '';
  // 状态变了（把 m1 改成完全不同的说法）→ 原来的建议不再成立。
  // 注意必须用**夹具自己的时钟**推进时间：HLC 是有因果序的，拿一个"更早"的时钟去写会被 LWW 忽略
  // （第一次写这条测试就是踩了这个坑：编辑根本没生效，于是"陈旧"其实并不陈旧）。
  advance();
  materializer.applyAll([
    memoryUpsert(base, {
      memoryId: 'm1',
      text: '换了个完全不同的说法：她喜欢在雪天开窗。',
      keys: [],
      importance: 50,
      sourceMessageIds: [],
      createdBy: 'user',
    }),
  ]);

  const applied = await store.apply(id);
  assert.equal(applied.ok, false);
  if (applied.ok) return;
  assert.match(applied.error, /已经不适用/);
  assert.deepEqual(appends, [], '拒绝时不得写入');
});

test('撤销把内容投影还原（逐字节口径见 packages/tuner 的文件头说明）', async () => {
  const { store, materializer } = makeStore();
  const original = memoryContentProjection(materializer.state);
  const id = (await store.suggest())[0]?.id ?? '';
  await store.apply(id);
  assert.notEqual(memoryContentProjection(materializer.state), original);

  const undoable = await store.pendingUndo();
  assert.ok(undoable !== undefined, '应用之后应当有一条可撤销记录');
  assert.deepEqual(await store.undo(), { ok: true });
  assert.equal(memoryContentProjection(materializer.state), original, '撤销必须还原到与原来相同');
  assert.equal(await store.pendingUndo(), undefined, '撤销之后就不该再撤销一次');
  assert.deepEqual(await store.undo(), { ok: false, error: '没有可撤销的应用' });
});
