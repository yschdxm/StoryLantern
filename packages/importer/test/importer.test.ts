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
});

test('导入：世界书（CCv3 数组形态）', async () => {
  const imported = await importFile('ccv3-lorebook.json', new TextEncoder().encode(textOf('lorebooks/ccv3-lorebook.json')));
  assert.equal(imported.kind, 'lorebook');
  assert.ok((imported as ImportedLorebookFile).lorebook.entries.length > 0);
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
  assert.ok(chat.notes.some((note) => note.includes('候选')));
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
