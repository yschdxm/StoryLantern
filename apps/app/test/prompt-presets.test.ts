import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PRESETS,
  PRESET_ARCHIVE_NOTE,
  PRESET_SETTING_KEY,
  listPresets,
  parsePresetFile,
  removePreset,
  savePreset,
  serializePresetCollection,
  serializePresetFile,
  type PromptPreset,
} from '../src/data/prompt-presets.ts';

/** B1/B22/B29：ST 预设的兼容导入/导出（只存档，不接运行时装配）。 */

const CC_JSON = JSON.stringify({
  name: '我的聊天预设',
  temperature: 0.8,
  prompts: [{ identifier: 'main', content: '你是 {{char}}。' }],
  prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }],
  top_p: 0.95,
});

const TC_JSON = JSON.stringify({
  name: '文字补全预设',
  story_string: '[{{char}} 的设定]',
  chat_start: '开始对话',
  example_dialogue: '<START>',
  temp: 0.7,
});

function presetOf(patch: Partial<PromptPreset> = {}): PromptPreset {
  return {
    id: 'p1', name: '预设一', kind: 'chat_completion', source: 'st',
    raw: { prompts: [], temperature: 0.8 }, importedAt: 1_700_000_000_000,
    notes: [PRESET_ARCHIVE_NOTE], ...patch,
  };
}

test('解析 ST Chat Completion：kind/name/raw 原样保留，notes 写明仅存档', () => {
  const result = parsePresetFile(CC_JSON, { now: 123, id: 'cc-1' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.preset.kind, 'chat_completion');
  assert.equal(result.preset.name, '我的聊天预设');
  assert.equal(result.preset.source, 'st');
  assert.equal(result.preset.importedAt, 123);
  assert.deepEqual(result.preset.raw, JSON.parse(CC_JSON));
  assert.deepEqual(result.preset.notes, [PRESET_ARCHIVE_NOTE]);
  // 同一份文件哈希 id 稳定（不去时间/随机）
  const first = parsePresetFile(CC_JSON);
  const second = parsePresetFile(CC_JSON);
  assert.equal(first.ok && first.preset.id, second.ok && second.preset.id);
});

test('解析 ST Text Completion：story_string/chat_start 识别；无 name 时按格式命名', () => {
  const result = parsePresetFile(TC_JSON, { now: 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.preset.kind, 'text_completion');
  assert.equal(result.preset.name, '文字补全预设');
  const unnamed = parsePresetFile(JSON.stringify({ story_string: 'x' }), { now: 1 });
  assert.equal(unnamed.ok && unnamed.preset.name, 'ST Text 预设');
});

test('坏文件明确报错（不静默、不猜格式）', () => {
  const badJson = parsePresetFile('{not json');
  assert.equal(badJson.ok, false);
  assert.equal(!badJson.ok && badJson.code, 'bad-json');
  const array = parsePresetFile('[1,2]');
  assert.equal(!array.ok && array.code, 'not-object');
  const unknown = parsePresetFile(JSON.stringify({ foo: 1 }));
  assert.equal(!unknown.ok && unknown.code, 'unknown-format');
});

test('导出：raw 优先、原样写回；整组导出也是 raw 数组', () => {
  const parsed = parsePresetFile(CC_JSON, { now: 1, id: 'cc-1' });
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  const exported = serializePresetFile({ ...parsed.preset, name: '改过的名字', notes: ['x'] });
  assert.deepEqual(JSON.parse(exported), JSON.parse(CC_JSON), '导出只写 raw，不夹带本应用字段');
  const collection = JSON.parse(serializePresetCollection([parsed.preset])) as unknown[];
  assert.deepEqual(collection[0], JSON.parse(CC_JSON));
});

test('存储：坏 JSON/坏条目/重复条目跳过并计数', () => {
  assert.deepEqual(listPresets({}), { presets: [], skipped: 0 });
  assert.deepEqual(listPresets({ [PRESET_SETTING_KEY]: '{oops' }), { presets: [], skipped: 1 });
  assert.deepEqual(listPresets({ [PRESET_SETTING_KEY]: '"string"' }), { presets: [], skipped: 1 });

  const valid = presetOf({ id: 'a', name: '甲' });
  const store = JSON.stringify([
    valid,
    { id: 'bad' },
    { ...valid },
    { ...valid, id: 'b', name: '甲' },
    { ...valid, id: 'c', name: '丙' },
  ]);
  const listed = listPresets({ [PRESET_SETTING_KEY]: store });
  assert.deepEqual(listed.presets.map((item) => item.id), ['a', 'c']);
  assert.equal(listed.skipped, 3, '坏条目 1 + 重复 id 1 + 重复 name 1');
});

test('保存：按 id/name 去重替换；满 50 条不再追加；删除幂等', () => {
  const base = { [PRESET_SETTING_KEY]: '' };
  const first = savePreset(base, presetOf({ id: 'a', name: '甲' }));
  assert.equal(first.saved, true);
  assert.deepEqual(listPresets(first.settings).presets.map((item) => item.id), ['a']);

  const renamed = savePreset(first.settings, presetOf({ id: 'b', name: '甲', raw: { prompts: ['x'] } }));
  const afterReplace = listPresets(renamed.settings);
  assert.equal(afterReplace.presets.length, 1, '同 name 视为替换');
  assert.deepEqual(afterReplace.presets[0]?.raw, { prompts: ['x'] });

  const second = savePreset(renamed.settings, presetOf({ id: 'b2', name: '乙' }));
  assert.equal(listPresets(second.settings).presets.length, 2);

  // 填到上限后：新条目被拒（settings 不变），同 id 仍可替换
  let settings = second.settings;
  for (let index = 2; index < MAX_PRESETS; index += 1) {
    settings = savePreset(settings, presetOf({ id: `p${index}`, name: `预设${index}` })).settings;
  }
  assert.equal(listPresets(settings).presets.length, MAX_PRESETS);
  const full = savePreset(settings, presetOf({ id: 'overflow', name: '溢出' }));
  assert.equal(full.saved, false);
  assert.equal(full.reason, 'full');
  assert.equal(full.settings, settings, '满额时设置不变');

  const removed = removePreset(settings, 'p2');
  assert.equal(listPresets(removed).presets.some((item) => item.id === 'p2'), false);
  assert.equal(listPresets(removePreset(removed, 'missing')).presets.length, MAX_PRESETS - 1, '删除不存在 id 幂等');
});
