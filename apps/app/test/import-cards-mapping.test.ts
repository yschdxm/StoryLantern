import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importText, type ImportedLorebookFile } from '../../../packages/importer/src/index.ts';
import { planLorebookImport } from '../src/data/import-cards.ts';
import { exportLorebook } from '../src/data/export-cards.ts';

/**
 * B3–B6：ST 高级世界书字段 ↔ `LoreTrigger` 的应用层映射。
 * 全字段一条用例（导入 → 卡片 → 导出 → 再导入），外加"没给字段就不产生空 trigger"。
 */

const NOW = 1_700_000_000_000;

const ST_ENTRY = {
  uid: 0,
  key: ['铜铃'],
  keysecondary: ['遗物'],
  comment: '遗物',
  content: '铜铃是遗物。',
  constant: false,
  disable: false,
  order: 10,
  depth: 4,
  excludeRecursion: true,
  preventRecursion: true,
  delayUntilRecursion: 2,
  selectiveLogic: 3,
  group: '夜',
  groupWeight: 17,
  sticky: 3,
  cooldown: 5,
  delay: 1,
  matchWholeWords: true,
};

function imported(entry: Record<string, unknown>): ImportedLorebookFile {
  return importText('world.json', JSON.stringify({ entries: { '0': entry } })) as ImportedLorebookFile;
}

test('B3–B6 全字段：导入落 trigger，导出写回 ST 原字段，再导入仍相等', () => {
  const first = planLorebookImport(imported(ST_ENTRY).lorebook, { now: NOW, id: 'book-1' });
  const trigger = first.cards[0]?.trigger;
  assert.ok(trigger !== undefined);
  assert.equal(trigger.selective_logic, 3);
  assert.equal(trigger.exclude_recursion, true);
  assert.equal(trigger.prevent_recursion, true);
  assert.equal(trigger.delay_until_recursion, 2);
  assert.equal(trigger.group, '夜');
  assert.equal(trigger.group_weight, 17);
  assert.equal(trigger.sticky, 3);
  assert.equal(trigger.cooldown, 5);
  assert.equal(trigger.delay, 1);

  const exported = exportLorebook(first.pack, first.cards);
  const payload = JSON.parse(exported.json) as { entries: Record<string, Record<string, unknown>> };
  const entry = payload.entries['0'];
  assert.ok(entry !== undefined);
  assert.equal(entry['selectiveLogic'], 3);
  assert.equal(entry['exclude_recursion'], true);
  assert.equal(entry['preventRecursion'], true);
  assert.equal(entry['delayUntilRecursion'], 2);
  assert.equal(entry['group'], '夜');
  assert.equal(entry['groupWeight'], 17);
  assert.equal(entry['sticky'], 3);
  assert.equal(entry['cooldown'], 5);
  assert.equal(entry['delay'], 1);
  assert.equal(entry['selective'], true);

  // B3–B6 字段已能往返：losses 里不能出现它们
  for (const loss of [
    'lore.trigger.selective_logic',
    'lore.trigger.exclude_recursion',
    'lore.trigger.prevent_recursion',
    'lore.trigger.delay_until_recursion',
    'lore.trigger.group',
    'lore.trigger.group_weight',
    'lore.trigger.sticky',
    'lore.trigger.cooldown',
    'lore.trigger.delay',
  ]) {
    assert.equal(exported.losses.includes(loss), false, `${loss} 已能往返，不该报丢失`);
  }

  const back = planLorebookImport(imported(entry).lorebook, { now: NOW, id: 'book-2' });
  assert.deepEqual(back.cards[0]?.trigger, trigger, '导出→再导入后 trigger 完全一致');
});

test('B3–B6：delayUntilRecursion 布尔兼容（true→1，false/缺省不写）；无字段不产生空 trigger', () => {
  const trueCase = planLorebookImport(imported({ ...ST_ENTRY, delayUntilRecursion: true }).lorebook, { now: NOW, id: 'b1' });
  assert.equal(trueCase.cards[0]?.trigger?.delay_until_recursion, 1);

  const falseCase = planLorebookImport(imported({ ...ST_ENTRY, delayUntilRecursion: false }).lorebook, { now: NOW, id: 'b2' });
  assert.equal('delay_until_recursion' in (falseCase.cards[0]?.trigger ?? {}), false);

  // 只有 ST 基础字段（没有 B3–B6）时，trigger 里不该出现这些可选键
  const plain = planLorebookImport(
    imported({ key: ['灯'], comment: '灯', content: '灯亮着。', order: 1, disable: false, constant: false }).lorebook,
    { now: NOW, id: 'b3' },
  );
  const trigger = plain.cards[0]?.trigger ?? {};
  for (const key of [
    'selective_logic',
    'exclude_recursion',
    'prevent_recursion',
    'delay_until_recursion',
    'group',
    'group_weight',
    'sticky',
    'cooldown',
    'delay',
  ]) {
    assert.equal(key in trigger, false, `没给的 ${key} 不能凭空写进 trigger`);
  }
});
