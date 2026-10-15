import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Materializer } from '../../../packages/oplog/src/index.ts';
import { HlcClock } from '../../../packages/oplog/src/hlc.ts';
import { createLocalLoreStore } from '../src/data/local-lore-store.ts';
import { createLoreStore } from '../src/data/op-lore-store.ts';
import type { RepositoryState } from '../src/data/memory-repository.ts';

/**
 * 世界书条目仓储的**幂等契约**测试。
 *
 * 为什么单独写这一条：这个边界（草稿 → 仓储 → 视图）**咬过我两次** ——
 * 第一次是 \`comment\` 字段在协议层根本不存在（导出时被静默丢掉）；
 * 第二次是"给了 id 就当成更新"，导致第一次导出抛「找不到该条目」，
 * 而改用"调用方先查存在性"又让随机 id 混进来、重复导出继续追加。
 * 两次都是**真机**发现的，单元测试全绿 —— 因为当时没有任何测试穿过这条边界。
 *
 * 这里把契约钉死：**调用方给的 id 不存在 → 以该 id 新建；存在 → 更新**。
 */

function opStore(): ReturnType<typeof createLoreStore> {
  const materializer = new Materializer();
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  return createLoreStore({
    withReady: (action) => action(),
    materializer: () => materializer,
    appendAndApply: async (ops) => {
      for (const op of ops) materializer.apply(op);
    },
    base: () => ({ deviceId: 'device-a', clock }),
  });
}

function localStore(): ReturnType<typeof createLocalLoreStore> {
  let sequence = 0;
  const state = {
    characters: [],
    sessions: [],
    messages: [],
    lorebooks: [],
    memories: [],
    summaries: [],
    facts: [],
    settings: {},
    sequence: 0,
  } as unknown as RepositoryState;
  return createLocalLoreStore({
    state,
    now: () => 1_700_000_000_000,
    commit: () => undefined,
    nextId: () => `id-${(sequence += 1)}`,
  });
}

for (const [label, make] of [
  ['op 仓储', opStore],
  ['内存仓储', localStore],
] as const) {
  test(`${label}：带自定义 id 的条目，第一次是新建、第二次是更新（幂等）`, async () => {
    const store = make();
    const book = await store.save({ name: 'LanternLore', description: '', characterIds: [], enabled: true });

    const draft = {
      lorebookId: book.id,
      id: 'fact-f1',
      keys: ['铜铃'],
      content: '铜铃是父亲留下来的遗物。',
      comment: '来源：M1｜状态：accepted｜置信：70',
    };
    const first = await store.saveEntry(draft);
    assert.equal(first.entries.length, 1, '第一次应当以给定的 id 新建');
    assert.equal(first.entries[0]?.id, 'fact-f1');

    const second = await store.saveEntry({ ...draft, content: '铜铃是父亲留下来的遗物（改过一遍）。' });
    assert.equal(second.entries.length, 1, '同一个 id 再存一次是**更新**，不是又加一条');
    assert.equal(second.entries[0]?.id, 'fact-f1');
    assert.equal(second.entries[0]?.content, '铜铃是父亲留下来的遗物（改过一遍）。');
    assert.equal(second.entries[0]?.comment, '来源：M1｜状态：accepted｜置信：70', '注释也必须跟着存下来');
  });

  test(`${label}：条目被删后再用同一个 id，是新建而不是复活墓碑`, async () => {
    const store = make();
    const book = await store.save({ name: 'LanternLore', description: '', characterIds: [], enabled: true });
    await store.saveEntry({ lorebookId: book.id, id: 'fact-f1', keys: ['铜铃'], content: '第一版' });
    await store.removeEntry(book.id, 'fact-f1');

    const again = await store.saveEntry({ lorebookId: book.id, id: 'fact-f1', keys: ['铜铃'], content: '第二版' });
    assert.equal(again.entries.length, 1, '同一个 id 应当重新出现一条，而不是消失');
    assert.equal(again.entries[0]?.content, '第二版');
  });
}
