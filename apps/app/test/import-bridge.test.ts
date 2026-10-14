import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatImportPlan, characterDraftFrom, withLorebook } from '../src/data/import-bridge.ts';
import { createAppStore } from '../src/app/state.ts';
import { createMemoryRepository } from '../src/data/memory-repository.ts';
import type { ImportedCharacter, ImportedChat } from '../../../packages/importer/src/index.ts';

function card(overrides: Partial<ImportedCharacter> = {}): ImportedCharacter {
  return {
    kind: 'character',
    source: 'x.png',
    name: '星野',
    description: '夜巡的守望者',
    personality: '克制',
    scenario: '隘口',
    firstMessage: '「进来吧。」',
    exampleDialogue: '{{user}}: 在吗',
    spec: 'chara_card_v2',
    notes: [],
    ...overrides,
  };
}

function chat(overrides: Partial<ImportedChat> = {}): ImportedChat {
  return {
    kind: 'chat',
    source: 'a.jsonl',
    characterName: '星野',
    title: '旅人 与 星野',
    messages: [
      { role: 'user', content: '在路上', createdAt: 1_700_000_000_000 },
      { role: 'assistant', content: '灯还亮着', createdAt: 1_700_000_001_000 },
    ],
    notes: [],
    ...overrides,
  };
}

test('导入映射：角色卡 6 个字段全部落到草稿，名字超长会被截断', () => {
  const draft = characterDraftFrom(card({ name: 'x'.repeat(80) }));
  assert.equal(draft.name.length, 60);
  assert.equal(draft.description, '夜巡的守望者');
  assert.equal(draft.personality, '克制');
  assert.equal(draft.scenario, '隘口');
  assert.equal(draft.firstMessage, '「进来吧。」');
  assert.equal(draft.exampleDialogue, '{{user}}: 在吗');
});

test('导入映射：世界书并入「参考设定」，空条目被跳过，无世界书时不改动场景', () => {
  assert.equal(withLorebook('隘口', undefined), '隘口');

  const merged = withLorebook('隘口', {
    name: '星野的设定',
    description: '',
    entries: [
      { keys: ['灯'], secondaryKeys: [], content: '灯不会说谎。', name: '条目 0', enabled: true, constant: false },
      { keys: [], secondaryKeys: [], content: '   ', name: '空条目', enabled: true, constant: false },
    ],
  });
  assert.match(merged, /隘口/);
  assert.match(merged, /【参考设定：星野的设定】/);
  assert.match(merged, /- 灯不会说谎。（触发：灯）/);
  assert.ok(!merged.includes('空条目'), '空内容不该留下骨架');
});

test('导入映射：聊天记录优先挂到同名角色，没有同名才新建', () => {
  const existing = {
    id: 7,
    name: '星野',
    description: '',
    personality: '',
    scenario: '',
    firstMessage: '',
    exampleDialogue: '',
    createdAt: 0,
    updatedAt: 0,
  };
  const withExisting = chatImportPlan(chat(), [existing]);
  assert.equal(withExisting.existingCharacter?.id, 7);
  assert.equal(withExisting.messages.length, 2);
  assert.equal(withExisting.messages[0]?.createdAt, 1_700_000_000_000);

  const withoutExisting = chatImportPlan(chat(), []);
  assert.equal(withoutExisting.existingCharacter, undefined);
  assert.equal(withoutExisting.characterName, '星野');
});

test('导入映射：原始文件没给时间时不伪造 1970 年', () => {
  const plan = chatImportPlan(chat({ messages: [{ role: 'user', content: 'hi', createdAt: 0 }] }), []);
  assert.equal(plan.messages[0]?.createdAt, undefined);
});

test('导入落库：聊天记录按原顺序与原时间戳写入，重启后仍按时间正序读出', async () => {
  const repository = createMemoryRepository();
  const store = createAppStore(repository);
  await store.actions.refresh();

  const plan = chatImportPlan(chat(), []);
  const character = await store.actions.saveCharacter({ name: plan.characterName });
  const session = await store.actions.createSession(character.id, plan.title);
  for (const message of plan.messages) {
    await store.actions.appendMessage(
      session.id,
      message.role,
      message.content,
      ...(message.createdAt === undefined ? [] : [message.createdAt]),
    );
  }

  const messages = await repository.messages.list(session.id);
  assert.deepEqual(
    messages.map((message) => `${message.role}:${message.content}`),
    ['user:在路上', 'assistant:灯还亮着'],
  );
  assert.equal(messages[0]?.createdAt, 1_700_000_000_000, '导入的历史必须保留原始时间');
  assert.equal(messages[1]?.createdAt, 1_700_000_001_000);

  // 会话列表的摘要取自最后一条
  const listed = await repository.sessions.list();
  assert.equal(listed[0]?.messageCount, 2);
  assert.equal(listed[0]?.lastMessage, '灯还亮着');
});

test('导入落库：逐条追加后，内存里的会话摘要立刻是最后一条（列表不会显示过期摘要）', async () => {
  const repository = createMemoryRepository();
  const store = createAppStore(repository);
  await store.actions.refresh();

  const character = await store.actions.saveCharacter({ name: '星野' });
  const session = await store.actions.createSession(character.id, '旅人 与 星野');
  assert.equal(store.getState().sessions[0]?.lastMessage, '', '新会话还没有消息');

  await store.actions.appendMessage(session.id, 'user', '在路上', 1_700_000_000_000);
  await store.actions.appendMessage(session.id, 'assistant', '灯还亮着', 1_700_000_001_000);

  const summary = store.getState().sessions.find((item) => item.id === session.id);
  assert.equal(summary?.messageCount, 2);
  assert.equal(summary?.lastMessage, '灯还亮着', '导入历史后列表摘要必须是最后一条，不能停在上一次刷新');
});
