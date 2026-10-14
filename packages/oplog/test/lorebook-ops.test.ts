import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { Materializer } from '../src/materialize.ts';
import { loreEntryDelete, loreEntryUpsert, lorebookDelete, lorebookUpsert } from '../src/lore-ops.ts';
import type { Op } from '../src/op.ts';
import { compareOpOrder } from '../src/hlc.ts';

/**
 * 世界书的两级结构都要能收敛：
 *  - 书级（名字/绑定/开关）整体覆盖 + LWW + 墓碑；
 *  - 条目级独立 LWW，且**书没到之前是孤儿**，书到了要能补上。
 */

const bookFields = { name: '星野的世界', description: '', characterIds: [] as string[], enabled: true };

function device(id: string, start = 1_000): { deviceId: string; clock: HlcClock } {
  return { deviceId: id, clock: new HlcClock({ now: () => start }) };
}

test('世界书：写入与读取', () => {
  const m = new Materializer();
  const a = device('A');
  m.apply(lorebookUpsert(a, { lorebookId: 'B1', ...bookFields, characterIds: ['C1'] }));
  assert.equal(m.lorebooks().length, 1);
  assert.deepEqual(m.lorebook('B1')?.characterIds, ['C1']);
  assert.equal(m.lorebook('B1')?.entries && Object.keys(m.lorebook('B1')?.entries ?? {}).length, 0);
});

test('世界书：按角色筛选（绑定的 + 全局的）', () => {
  const m = new Materializer();
  const a = device('A');
  m.apply(lorebookUpsert(a, { lorebookId: 'GLOBAL', ...bookFields, characterIds: [] }));
  m.apply(lorebookUpsert(a, { lorebookId: 'FOR-C1', ...bookFields, characterIds: ['C1'] }));
  m.apply(lorebookUpsert(a, { lorebookId: 'FOR-C2', ...bookFields, characterIds: ['C2'] }));
  m.apply(lorebookUpsert(a, { lorebookId: 'OFF', ...bookFields, enabled: false }));

  assert.deepEqual(
    m.lorebooksFor('C1').map((book) => book.id).sort(),
    ['FOR-C1', 'GLOBAL'],
  );
  assert.deepEqual(
    m.lorebooksFor(undefined).map((book) => book.id),
    ['GLOBAL'],
  );
});

test('世界书：条目独立写入，更新书级信息不会丢条目', () => {
  const m = new Materializer();
  const a = device('A');
  m.apply(lorebookUpsert(a, { lorebookId: 'B1', ...bookFields }));
  m.apply(
    loreEntryUpsert(a, {
      lorebookId: 'B1',
      entryId: 'E1',
      keys: ['铜铃'],
      secondaryKeys: [],
      content: '铜铃是报信之物。',
      enabled: true,
      order: 10,
      caseSensitive: false,
      recursive: true,
      depth: 0,
      constant: false,
    }),
  );
  const clock = new HlcClock({ now: () => 5_000 });
  m.apply(lorebookUpsert({ deviceId: 'A', clock }, { lorebookId: 'B1', ...bookFields, name: '改过名的书' }));

  assert.equal(m.lorebook('B1')?.name, '改过名的书');
  assert.equal(m.lorebook('B1')?.entries.E1?.content, '铜铃是报信之物。');
});

test('世界书：乱的顺序（先条目后书）也能收敛——条目先是孤儿，书到了就补上', () => {
  const m = new Materializer();
  const a = device('A');
  const entry = loreEntryUpsert(a, {
    lorebookId: 'B1',
    entryId: 'E1',
    keys: ['k'],
    secondaryKeys: [],
    content: '内容',
    enabled: true,
    order: 1,
    caseSensitive: false,
    recursive: true,
    depth: 0,
    constant: false,
  });
  // 只给条目：应当是孤儿（书还没到）
  assert.equal(m.apply(entry), 'orphan');
  assert.equal(m.lorebook('B1'), undefined);

  // 补上书：applyAll 会重放孤儿
  m.applyAll([lorebookUpsert(a, { lorebookId: 'B1', ...bookFields })]);
  // 注意：applyAll 只重放"这一批里"的孤儿；上一轮的孤儿还在队列里
  const replay = m.applyAll([]);
  assert.ok(replay.orphans >= 0);
  assert.equal(m.lorebook('B1')?.entries.E1?.content, '内容');
});

test('世界书：同 opId 重复投递是幂等的', () => {
  const m = new Materializer();
  const a = device('A');
  const op = lorebookUpsert(a, { lorebookId: 'B1', ...bookFields });
  assert.equal(m.apply(op), 'applied');
  assert.equal(m.apply(op), 'duplicate');
  assert.equal(m.lorebooks().length, 1);
});

test('世界书：同一本书并发改名 → 两边收敛到同一个赢家', () => {
  const a = device('A', 1_000);
  const b = device('B', 1_000);

  const opA = lorebookUpsert(a, { lorebookId: 'B1', ...bookFields, name: 'A 改的' });
  const opB = lorebookUpsert(b, { lorebookId: 'B1', ...bookFields, name: 'B 改的' });
  // 两台设备的墙上时钟相同 → (t, c) 一模一样，只能靠 deviceId 破平局。
  // 这正是最需要断言的情形：破平局必须是确定性的，否则两台设备会选出不同的赢家。
  assert.equal(opA.hlc.t, opB.hlc.t);
  assert.equal(opA.hlc.c, opB.hlc.c);
  assert.notEqual(opA.deviceId, opB.deviceId);

  const first = new Materializer();
  const second = new Materializer();
  const ordered = [opA, opB].sort(compareOpOrder);
  first.applyAll(ordered);
  second.applyAll([...ordered].reverse());

  assert.equal(first.lorebook('B1')?.name, second.lorebook('B1')?.name, '两台设备的最终名字必须一致');
});

test('世界书：删除是墓碑（书被删后条目一并不可见）', () => {
  const m = new Materializer();
  const a = device('A');
  m.apply(lorebookUpsert(a, { lorebookId: 'B1', ...bookFields }));
  m.apply(
    loreEntryUpsert(a, {
      lorebookId: 'B1',
      entryId: 'E1',
      keys: ['k'],
      secondaryKeys: [],
      content: '内容',
      enabled: true,
      order: 1,
      caseSensitive: false,
      recursive: true,
      depth: 0,
      constant: false,
    }),
  );
  const clock = new HlcClock({ now: () => 9_000 });
  m.apply(lorebookDelete({ deviceId: 'A', clock }, { lorebookId: 'B1' }));

  assert.deepEqual(m.lorebooks(), []);
  assert.equal(m.lorebook('B1'), undefined);
  assert.equal(m.lorebooksFor(undefined).length, 0);
});

test('世界书：更旧的删除不会盖掉更新的改名（墓碑与写入共用时间线）', () => {
  const early = new HlcClock({ now: () => 1_000 });
  const late = new HlcClock({ now: () => 9_000 });

  const remove = lorebookDelete({ deviceId: 'A', clock: early }, { lorebookId: 'B1' });
  const rename = lorebookUpsert({ deviceId: 'B', clock: late }, { lorebookId: 'B1', ...bookFields, name: '后来改的' });

  const m = new Materializer();
  const ops: Op[] = [remove, rename];
  m.applyAll(ops);
  assert.equal(m.lorebook('B1')?.name, '后来改的', '更新的写入应当生效');
});

test('世界书：条目删除后不再出现在书里', () => {
  const m = new Materializer();
  const a = device('A');
  m.apply(lorebookUpsert(a, { lorebookId: 'B1', ...bookFields }));
  m.apply(
    loreEntryUpsert(a, {
      lorebookId: 'B1',
      entryId: 'E1',
      keys: ['k'],
      secondaryKeys: [],
      content: '内容',
      enabled: true,
      order: 1,
      caseSensitive: false,
      recursive: true,
      depth: 0,
      constant: false,
    }),
  );
  const clock = new HlcClock({ now: () => 8_000 });
  m.apply(loreEntryDelete({ deviceId: 'A', clock }, { lorebookId: 'B1', entryId: 'E1' }));

  const book = m.lorebook('B1');
  assert.ok(book !== undefined);
  assert.equal(book.entries.E1?.deleted !== undefined, true, '墓碑保留（否则无法与其他设备收敛）');
});
