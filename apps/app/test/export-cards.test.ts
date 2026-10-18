import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importText, type ImportedCharacter } from '../../../packages/importer/src/index.ts';
import type { CardMeta, CharacterCard } from '../../../packages/cards/src/index.ts';
import { planCharacterImport } from '../src/data/import-cards.ts';
import { exportCharacterCard } from '../src/data/export-cards.ts';
import { regexScriptsOfExtensions } from '../src/data/regex-scripts.ts';

/** B13/B14：正则脚本与快捷回复的导入 → 卡片 → 导出 → 再导入往返。 */

const NOW = 1_700_000_000_000;

const CARD_JSON = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '星野',
    description: '夜巡的守望者。',
    personality: '克制、敏锐。',
    extensions: {
      regex_scripts: [
        {
          id: 'fix-ooc', scriptName: '去掉 OOC 括号', findRegex: '/\\(OOC:.*?\\)/gs',
          replaceString: '', placement: [2], disabled: false, markdownOnly: false, promptOnly: true,
        },
      ],
      quick_replies: [
        { id: 'hello', label: '打招呼', message: '{{char}}：「来了。」' },
        { id: 'ask', label: '追问', message: '{{user}} 继续追问。', enabled: false },
      ],
      'fixture/note': { generated: true },
    },
  },
});

function imported(json: string): ImportedCharacter {
  return importText('card.json', json) as ImportedCharacter;
}

test('导入：正则脚本与快捷回复进卡片；已消费的 extensions 键不再报丢弃', () => {
  const plan = planCharacterImport(imported(CARD_JSON), { now: NOW, id: 'card-1' });
  const regex = regexScriptsOfExtensions(plan.card.extensions);
  assert.deepEqual(regex.map((item) => item.id), ['fix-ooc']);
  assert.equal(regex[0]?.placement, 'ai_output');
  assert.deepEqual(regex[0]?.flags, { global: true, dotAll: true });
  assert.equal(regex[0]?.enabled, undefined, 'enabled=false 才写；缺省即启用');
  assert.deepEqual(plan.card.quick_replies?.map((reply) => reply.id), ['hello', 'ask']);
  assert.equal(plan.card.quick_replies?.[1]?.enabled, false);
  assert.deepEqual(plan.discarded, ['fixture/note'], '只丢真正没承载的扩展键');
  assert.ok(plan.notes.some((note) => note.includes('正则脚本 1 条已保存')));
  assert.ok(plan.notes.some((note) => note.includes('快捷回复 2 条已保存')));
});

test('导出→再导入：regex_scripts / quick_replies 内容保持一致，不报 extensions 丢失', () => {
  const first = planCharacterImport(imported(CARD_JSON), { now: NOW, id: 'card-1' });
  const exported = exportCharacterCard(first.card, first.stash);
  assert.equal(exported.losses.includes('extensions'), false, '已映射的扩展不能再报整块丢失');

  const payload = JSON.parse(exported.json) as { data: { extensions: Record<string, unknown> } };
  const regexRaw = payload.data.extensions['regex_scripts'] as Array<Record<string, unknown>>;
  const quickRaw = payload.data.extensions['quick_replies'] as Array<Record<string, unknown>>;
  assert.equal(regexRaw[0]?.['findRegex'], '/\\(OOC:.*?\\)/gs');
  assert.deepEqual(regexRaw[0]?.['placement'], [2]);
  assert.equal(quickRaw[0]?.['label'], '打招呼');
  assert.equal(quickRaw[1]?.['enabled'], false);

  const second = planCharacterImport(imported(exported.json), { now: NOW, id: 'card-2' });
  assert.deepEqual(second.card.quick_replies, first.card.quick_replies);
  const secondRegex = regexScriptsOfExtensions(second.card.extensions);
  assert.deepEqual(secondRegex.map((item) => ({ ...item, id: 'x' })), regexScriptsOfExtensions(first.card.extensions).map((item) => ({ ...item, id: 'x' })));
});

test('card.extensions 里其它命名空间：导出仍写回（值原样保留），但列为潜在丢失', () => {
  const meta: CardMeta = {
    id: 'c1', schema: 'rolecard/v1', name: '林霜', version: '1.0.0',
    language: 'zh-CN', description: '', rating: 'general',
  };
  const card: CharacterCard = {
    card_type: 'character', meta,
    identity: { name: '林霜', background: '' },
    persona: { summary: '', traits: [], knowledge_boundary: '', ability_boundary: '' },
    speech: { style: '' },
    extensions: { storylantern: { regex_scripts: [] }, other: { keep: true } },
  };
  const exported = exportCharacterCard(card, []);
  assert.equal(exported.losses.includes('extensions.other'), true);
  assert.equal(exported.losses.includes('extensions.storylantern.regex_scripts'), false);
});
