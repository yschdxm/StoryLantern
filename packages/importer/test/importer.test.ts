import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { importFile, importText, ImportError, type ImportedCharacter, type ImportedChat, type ImportedLorebookFile } from '../src/index.ts';

/**
 * 导入器对着**真实格式样本**测（fixtures/），不是对着自己编的假数据测。
 *
 * 样本里既有正常文件也有畸形文件：畸形输入必须"明确失败、不崩溃、不丢数据"，
 * 这条比"能导入正常文件"更重要——用户手里的卡十有八九是别人改过的。
 */

const fixtures = (path: string): string => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));

function bytesOf(path: string): Uint8Array {
  return new Uint8Array(readFileSync(fixtures(path)));
}

function textOf(path: string): string {
  return readFileSync(fixtures(path), 'utf8');
}

function asCharacter(imported: unknown): ImportedCharacter {
  assert.ok(typeof imported === 'object' && imported !== null && (imported as { kind: string }).kind === 'character');
  return imported as ImportedCharacter;
}

// ---------------------------------------------------------------- 角色卡

test('导入：CCv2 JSON 卡（含内嵌世界书与备选开场白）', async () => {
  const card = asCharacter(await importFile('card-v2.json', new TextEncoder().encode(textOf('cards/card-v2.json'))));

  assert.equal(card.name, '星野');
  assert.equal(card.firstMessage, '「进来吧，风会替你关门。」');
  assert.match(card.exampleDialogue, /你守了多久/);
  assert.equal(card.spec, 'chara_card_v2');
  assert.equal(card.lorebook?.entries.length, 2, '内嵌世界书应被解析出来');
  assert.ok(card.notes.some((note) => note.includes('备选开场白')), '丢掉的备选开场白要有提示');
  assert.ok(card.notes.some((note) => note.includes('system prompt')));
});

test('导入：legacy（v1）扁平卡', async () => {
  const card = asCharacter(await importFile('card-v1.json', new TextEncoder().encode(textOf('cards/card-v1.json'))));
  assert.equal(card.spec, 'legacy');
  assert.ok(card.name.length > 0);
  assert.equal(typeof card.description, 'string');
});

test('导入：CCv3 JSON 卡', async () => {
  const card = asCharacter(await importFile('card-v3.json', new TextEncoder().encode(textOf('cards/card-v3.json'))));
  assert.equal(card.spec, 'chara_card_v3');
  assert.ok(card.name.length > 0);
  assert.ok(card.firstMessage.length > 0);
});

test('导入：PNG 卡（CCv2 的 chara 文本块，内容是 base64）', async () => {
  const card = asCharacter(await importFile('card-v2.png', bytesOf('cards/card-v2.png')));
  assert.equal(card.name, '星野');
  assert.equal(card.firstMessage, '「进来吧，风会替你关门。」');
});

test('导入：PNG 卡（CCv3 的 ccv3 文本块优先）', async () => {
  const card = asCharacter(await importFile('card-v3.png', bytesOf('cards/card-v3.png')));
  assert.equal(card.spec, 'chara_card_v3');
  assert.ok(card.name.length > 0);
});

test('导入：CHARX（ZIP + deflate，手写中央目录 + DecompressionStream）', async () => {
  const card = asCharacter(await importFile('card.charx', bytesOf('cards/card.charx')));
  assert.equal(card.name, '星野');
  assert.ok(card.firstMessage.length > 0);
});

// ---------------------------------------------------------------- 世界书

test('导入：世界书（ST 原生 uid→条目 map）', async () => {
  const imported = await importFile('st-world.json', new TextEncoder().encode(textOf('lorebooks/st-world.json')));
  assert.equal(imported.kind, 'lorebook');
  const book = (imported as ImportedLorebookFile).lorebook;
  assert.ok(book.entries.length >= 2);
  assert.ok(book.entries.some((entry) => entry.keys.includes('灯')));
  assert.ok(book.entries.every((entry) => typeof entry.content === 'string'));
  // ST 高级世界书字段原样保留，交给导入层映射（B3–B6）
  const first = book.entries.find((entry) => entry.keys.includes('灯'));
  assert.equal(first?.selectiveLogic, 0);
  assert.equal(first?.excludeRecursion, false);
  assert.equal(first?.preventRecursion, false);
  assert.equal(first?.delayUntilRecursion, false);
  assert.equal(first?.group, 'place');
  assert.equal(first?.groupWeight, 100);
  assert.equal(first?.sticky, 0);
  assert.equal(first?.cooldown, 0);
  assert.equal(first?.delay, 0);
});

test('导入：世界书（CCv3 数组形态）', async () => {
  const imported = await importFile('ccv3-lorebook.json', new TextEncoder().encode(textOf('lorebooks/ccv3-lorebook.json')));
  assert.equal(imported.kind, 'lorebook');
  assert.ok((imported as ImportedLorebookFile).lorebook.entries.length > 0);
});

// ---------------------------------------------------------------- 正则脚本 / 快捷回复

test('导入：正则脚本与快捷回复不再只计数，而是解析出原始条目', async () => {
  const json = JSON.stringify({
    spec: 'chara_card_v2',
    data: {
      name: '星野',
      description: '守望者。',
      extensions: {
        regex_scripts: [
          { id: 'r1', scriptName: '去 OOC', findRegex: '/\\(OOC:.*?\\)/gs', replaceString: '', placement: [2], disabled: false },
          { id: 'r2', scriptName: '坏条目', findRegex: '', placement: [1] },
        ],
        quick_replies: [
          { id: 'q1', label: '打招呼', message: '你好' },
          { id: 'q2', label: '禁用', message: '再见', enabled: false },
        ],
      },
    },
  });
  const card = asCharacter(await importText('card.json', json));
  assert.deepEqual(card.regexScripts?.map((script) => script.id), ['r1'], '空 findRegex 的条目跳过');
  assert.equal(card.regexScripts?.[0]?.placement[0], 2);
  assert.equal(card.regexScripts?.[0]?.findRegex, '/\\(OOC:.*?\\)/gs');
  assert.deepEqual(card.quickReplies?.map((reply) => reply.id), ['q1', 'q2']);
  assert.equal(card.quickReplies?.[1]?.enabled, false);
  assert.deepEqual(card.extensionKeys, [], 'regex_scripts / quick_replies 已消费，不再算丢弃');
  assert.ok(card.notes.some((note) => note.includes('正则脚本 1 条已解析')));
  assert.ok(card.notes.some((note) => note.includes('快捷回复 2 条已解析')));
});

// ---------------------------------------------------------------- 聊天记录

test('导入：单人聊天 JSONL（角色名、角色归属、候选回复有提示）', async () => {
  const imported = await importFile('single.jsonl', new TextEncoder().encode(textOf('chats/single.jsonl')));
  assert.equal(imported.kind, 'chat');
  const chat = imported as ImportedChat;
  assert.equal(chat.characterName, '星野');
  assert.match(chat.title, /旅人/);
  assert.ok(chat.messages.length >= 5);
  assert.equal(chat.messages[0]?.role, 'user');
  assert.equal(chat.messages[1]?.role, 'assistant');
  assert.ok(chat.messages.every((message) => message.content.trim() !== ''), '空消息不该进来');
  // swipes（多次生成）不再被丢掉：当前那条是正文，其余作为候选带进来
  const withCandidates = chat.messages.filter((message) => (message.candidates ?? []).length > 0);
  assert.ok(withCandidates.length > 0, '备选回复应当作为候选带进来，而不是只留一条');
  assert.ok(
    withCandidates.every((message) => (message.candidates ?? []).every((candidate) => candidate.trim() !== '')),
    '候选不该是空串',
  );
  assert.ok(chat.notes.some((note) => note.includes('候选')), '提示要说清候选被带进来了');
});

test('导入：群聊 JSONL 也能读出消息与角色名', async () => {
  const chat = (await importFile('group.jsonl', new TextEncoder().encode(textOf('chats/group.jsonl')))) as ImportedChat;
  assert.equal(chat.kind, 'chat');
  assert.ok(chat.messages.length > 0);
  assert.ok(chat.characterName.length > 0);
});

// ---------------------------------------------------------------- 畸形输入

test('导入：空文件 → 明确失败', () => {
  assert.throws(
    () => importText('empty.json', ''),
    (error: unknown) => error instanceof ImportError && error.code === 'empty-file',
  );
});

test('导入：坏 JSON → 明确失败而不是崩溃', () => {
  const text = textOf('malformed/bad-card.json');
  assert.throws(
    () => importText('bad-card.json', text),
    (error: unknown) => error instanceof ImportError && error.code === 'bad-json',
  );
});

test('导入：截断的 PNG → 明确失败', async () => {
  await assert.rejects(
    () => importFile('truncated-card.png', bytesOf('malformed/truncated-card.png')),
    (error: unknown) => error instanceof ImportError && (error.code === 'truncated-png' || error.code === 'no-card-in-png'),
  );
});

test('导入：坏 JSONL → 跳掉坏行，剩下的照常导入', () => {
  const chat = importText('bad-chat.jsonl', textOf('malformed/bad-chat.jsonl')) as ImportedChat;
  assert.equal(chat.kind, 'chat');
  assert.ok(chat.messages.length > 0, '坏行不该让整份记录失败');
  assert.ok(chat.notes.some((note) => note.includes('无法解析')));
});

test('导入：超深嵌套的 JSON 不崩（要么识别、要么明确说不知道）', () => {
  const text = textOf('malformed/deep-nesting.json');
  try {
    const imported = importText('deep-nesting.json', text);
    assert.ok(['character', 'lorebook', 'unknown', 'chat'].includes(imported.kind));
  } catch (cause) {
    assert.ok(cause instanceof ImportError, '必须是可读的 ImportError');
  }
});

test('导入：无法识别的 JSON → unknown，并说明原因', () => {
  const imported = importText('whatever.json', JSON.stringify({ hello: 'world' }));
  assert.equal(imported.kind, 'unknown');
  assert.ok(imported.kind === 'unknown' && imported.reason.length > 0);
});

test('聊天导入：名字只写在每行上（没有表头）时，也要采用行内的 character_name', () => {
  const lines = [
    JSON.stringify({ user_name: 'You', character_name: 'Rin', mes: 'hello', is_user: true }),
    JSON.stringify({ user_name: 'You', character_name: 'Rin', mes: 'hi', is_user: false, swipes: ['hi', 'hey'] }),
  ].join("\n");
  const result = importText('chat.jsonl', lines);
  assert.equal(result.kind, 'chat');
  if (result.kind !== 'chat') return;
  assert.equal(result.characterName, 'Rin', '行内的 character_name 应当被采用，而不是落到默认名');
});
test('角色卡：带正则脚本但字段缺失时跳过并如实报数量（不再只统计不导入）', () => {
  const card = {
    spec: 'chara_card_v2',
    data: {
      name: 'Rin',
      description: 'd',
      extensions: { regex_scripts: [{ scriptName: 'a' }, { scriptName: 'b' }] },
    },
  };
  const result = importText('card.json', JSON.stringify(card));
  assert.equal(result.kind, 'character');
  assert.equal(result.notes.some((note) => note.includes('跳过')), true, '缺字段的脚本要报跳过');
  assert.equal(result.notes.some((note) => note.includes('2 条')), true, '要报原始条数');
});
