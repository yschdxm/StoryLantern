import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { Materializer } from '../src/materialize.ts';
import { lorebookUpsert, loreEntryUpsert } from '../src/lore-ops.ts';

/**
 * 条目「注释」（SillyTavern 的 comment）的**跨层**回归测试。
 *
 * 为什么单独一条：这个字段原本**整条链路都不存在** —— 协议层 payload 没有它、物化不写它、
 * 视图不读它。于是"设定库导出时把 provenance 写进条目注释"这句话是**假的**：
 * 草稿层有（有单测），写库那一步被静默丢掉，而且**没有任何测试穿过这条边界**。
 * 现在从 op 一路查到物化记录，把这条边界钉住。
 */

const CLOCK = new HlcClock({ now: () => 1_700_000_000_000 });

function materialize(comment?: string): Materializer {
  const materializer = new Materializer();
  materializer.apply(
    lorebookUpsert({ deviceId: 'device-a', clock: CLOCK }, { lorebookId: 'b1', name: 'LanternLore', description: '', characterIds: [], enabled: true }),
  );
  materializer.apply(
    loreEntryUpsert({ deviceId: 'device-a', clock: CLOCK }, {
      lorebookId: 'b1',
      entryId: 'e1',
      keys: ['铜铃'],
      secondaryKeys: [],
      content: '铜铃是父亲留下来的遗物。',
      enabled: true,
      order: 100,
      caseSensitive: false,
      recursive: true,
      depth: 0,
      constant: false,
      ...(comment === undefined ? {} : { comment }),
    }),
  );
  return materializer;
}

test('注释能一路走到物化记录：来源：M1、M2｜状态：accepted｜置信：70', () => {
  const comment = '来源：M1、M2｜状态：accepted｜置信：70';
  const record = materialize(comment).state.lorebooks['b1']?.entries['e1'];
  assert.ok(record !== undefined);
  assert.equal(record.comment, comment, '这条边界以前是没有测试的，字段就是在这里丢的');
});

test('旧 op 没有 comment 字段时读成空字符串（不是 undefined，也不是丢掉整条）', () => {
  const record = materialize().state.lorebooks['b1']?.entries['e1'];
  assert.equal(record?.comment, '');
  assert.equal(record?.content, '铜铃是父亲留下来的遗物。');
});
