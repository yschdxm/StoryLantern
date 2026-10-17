import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importText } from '../src/index.ts';
import { exportCharacterJson, exportChatJsonl, exportImported, exportLorebookJson } from '../src/export.ts';
import type { ImportedCharacter, ImportedChat, ImportedLorebookFile } from '../src/types.ts';

/**
 * M1 退出判据：**导出同格式无损回写（未知字段保留）**。
 * 这里逐条钉住：导出的文件必须还能被自己导入，且原始文件里我们"不认识"的字段仍然在。
 */

const CARD_V3 = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  // 我们不认识的顶层字段：必须原样回来
  x_custom_top: { hello: 1 },
  data: {
    name: '霜',
    description: '守夜人的女儿。',
    personality: '沉默。',
    scenario: '雪夜。',
    first_mes: '“……你迟到了。”',
    mes_example: '<START>\n{{user}}: 你好\n{{char}}: 嗯。',
    system_prompt: '只用短句。',
    alternate_greetings: ['“……又是你。”'],
    // 不认识的 data 内字段
    extensions: { talkativeness: '0.5', depth_prompt: { depth: 4 } },
    character_book: {
      name: '霜的世界书',
      entries: [
        {
          keys: ['雪线'],
          content: '雪线以上没有信号。',
          comment: '雪线',
          enabled: true,
          // CCv3 的 decorators：我们不认识，但必须保留
          decorators: { match_whole_words: true },
          x_entry_custom: 'keep-me',
        },
      ],
    },
  },
};

function parseCard(): ImportedCharacter {
  const parsed = importText('a.png', JSON.stringify(CARD_V3));
  assert.equal(parsed.kind, 'character');
  return parsed as ImportedCharacter;
}

test('角色卡导出：已知字段按领域对象回写，未知字段（顶层/data/世界书条目）原样保留', () => {
  const card = parseCard();
  const exported = exportCharacterJson(card);

  assert.equal(exported['spec'], 'chara_card_v3');
  const data = exported['data'] as Record<string, unknown>;
  assert.equal(data['name'], '霜');
  assert.equal(data['first_mes'], '“……你迟到了。”');
  assert.deepEqual(data['alternate_greetings'], ['“……又是你。”']);
  // 不认识的东西一个都没丢
  assert.deepEqual(exported['x_custom_top'], { hello: 1 });
  assert.deepEqual(data['extensions'], { talkativeness: '0.5', depth_prompt: { depth: 4 } });
  const book = data['character_book'] as { entries: Record<string, unknown>[] };
  const bookEntry = book.entries[0];
  assert.ok(bookEntry !== undefined);
  assert.deepEqual(bookEntry['decorators'], { match_whole_words: true });
  assert.equal(bookEntry['x_entry_custom'], 'keep-me');
});

test('角色卡导出：导出物能被自己重新导入，领域字段一致（真正的往返）', () => {
  const first = parseCard();
  const text = `${JSON.stringify(exportCharacterJson(first), null, 2)}\n`;
  const again = importText('again.json', text);
  assert.equal(again.kind, 'character');
  const second = again as ImportedCharacter;
  for (const key of ['name', 'description', 'personality', 'scenario', 'firstMessage', 'systemPrompt'] as const) {
    assert.equal(second[key], first[key], `${key} 往返后必须一致`);
  }
  assert.deepEqual(second.alternateGreetings, first.alternateGreetings);
  assert.deepEqual(second.lorebook?.entries, first.lorebook?.entries);
});

test('角色卡导出：原始 JSON 挂在不可枚举属性上，不污染对外形状与序列化', () => {
  const card = parseCard();
  assert.ok(!Object.keys(card).includes('raw'), 'deepEqual/序列化看不到 raw');
  assert.ok(!JSON.stringify(card).includes('x_custom_top'), 'raw 不该被序列化出来');
});

test('角色卡导出：legacy 扁平格式也能导出', () => {
  const flat = { name: '旅人', description: '旧格式', first_mes: '嗯。' };
  const parsed = importText('legacy.json', JSON.stringify(flat)) as ImportedCharacter;
  const exported = exportCharacterJson(parsed, { format: 'legacy' });
  assert.equal(exported['spec'], undefined);
  assert.equal(exported['name'], '旅人');
  assert.equal(exported['description'], '旧格式');
});

test('世界书导出：ST 原生 map 形态往返后条目一致，条目未知字段保留', () => {
  const raw = {
    name: '旧世界书',
    entries: {
      0: { key: ['风'], content: '起风了。', comment: '风', enabled: true, x_keep: 42 },
      3: { key: ['雪'], keysecondary: ['夜'], content: '下雪了。', disable: true },
    },
  };
  const imported = importText('book.json', JSON.stringify(raw));
  assert.equal(imported.kind, 'lorebook');
  const book = (imported as ImportedLorebookFile).lorebook;
  const exported = exportLorebookJson(book);
  const data = exported['data'] as Record<string, unknown>;
  assert.equal(data['name'], '旧世界书');
  const entries = data['entries'] as Record<string, unknown>[];
  assert.equal(entries.length, 2);
  const first = entries[0];
  const second = entries[1];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first['x_keep'], 42);
  assert.equal(second['enabled'], false);

  // 再导入一次：条目内容与启用状态必须一致
  const again = importText('book2.json', JSON.stringify(exported)) as ImportedLorebookFile;
  assert.deepEqual(
    again.lorebook.entries.map((entry) => ({ keys: entry.keys, content: entry.content, enabled: entry.enabled })),
    book.entries.map((entry) => ({ keys: entry.keys, content: entry.content, enabled: entry.enabled })),
  );
});

test('聊天导出：JSONL 能被自己重新导入，角色/user 与候选回复都在', () => {
  const chat: ImportedChat = {
    kind: 'chat',
    source: 'old.jsonl',
    characterName: '霜',
    title: '雪夜',
    messages: [
      { role: 'user', content: '你好', createdAt: 1_700_000_000_000 },
      { role: 'assistant', content: '嗯。', candidates: ['嗯。', '嗯。……'], createdAt: 1_700_000_001_000 },
    ],
    notes: [],
  };
  const text = exportChatJsonl(chat);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  const reimported = importText('chat.jsonl', text) as ImportedChat;
  assert.equal(reimported.kind, 'chat');
  assert.equal(reimported.characterName, '霜');
  assert.equal(reimported.messages.length, 2);
  assert.equal(reimported.messages[0]?.content, '你好');
  assert.equal(reimported.messages[1]?.content, '嗯。');
  // candidates 的语义是"**其它**候选"（不含当前选中的那条）：导出时写 swipes 全量 + swipe_id，
  // 再导回来就只剩另一条 —— 与导入器的既有语义一致，也说明往返没丢东西
  assert.deepEqual(reimported.messages[1]?.candidates, ['嗯。……']);
});

test('统一导出入口：文件名沿用来源名；没有原始 JSON 时如实报告未知字段会丢', () => {
  const card = parseCard();
  const fromRaw = exportImported(card, '角色.png');
  assert.equal(fromRaw.name, '角色.json');
  assert.equal(fromRaw.lostUnknownFields, false);

  const synthetic: ImportedCharacter = { ...card };
  Object.defineProperty(synthetic, 'raw', { value: undefined, enumerable: false, configurable: true });
  const fromSynthetic = exportImported(synthetic, '手工.json');
  assert.equal(fromSynthetic.lostUnknownFields, true, '没有原始 JSON 时必须如实说未知字段会丢');
});
