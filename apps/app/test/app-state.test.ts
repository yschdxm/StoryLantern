import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeTabName, isRootRoute, parentOf, parseRoute, routeToHash, TABS, type Route } from '../src/app/router.ts';
import { createAppStore } from '../src/app/state.ts';
import { createMemoryRepository } from '../src/data/memory-repository.ts';

// ---------------------------------------------------------------- 路由

test('路由：hash 与 Route 往返一致，脏输入回落到根页面', () => {
  const routes = [
    { name: 'sessions' } as const,
    { name: 'characters' } as const,
    { name: 'settings' } as const,
    { name: 'settings', section: 'sync' } as const,
    { name: 'settings', section: 'about' } as const,
    { name: 'import' } as const,
    { name: 'chat', sessionId: '01JABCXYZ' } as const,
    { name: 'character', characterId: '01JABCXYZ' } as const,
    { name: 'character', characterId: 'new' } as const,
  ];
  for (const route of routes) {
    assert.deepEqual(parseRoute(routeToHash(route)), route);
  }

  assert.deepEqual(parseRoute(''), { name: 'sessions' });
  assert.deepEqual(parseRoute('#/'), { name: 'sessions' });
  assert.deepEqual(parseRoute('#/nonsense'), { name: 'sessions' });
  assert.deepEqual(parseRoute('#/import'), { name: 'import' });
  // 会话/角色 id 是 ULID 字符串：任何非空 token 都是合法 id，空的才回落
  assert.deepEqual(parseRoute('#/chat/'), { name: 'sessions' });
  assert.deepEqual(parseRoute('#/character/'), { name: 'characters' });
  assert.deepEqual(parseRoute('#/chat/01JABC?from=x'), { name: 'chat', sessionId: '01JABC' }, '查询串应被忽略');
  // 设置分区：已知分区直接渲染；未知分区回设置首页（不是掉回会话页）
  assert.deepEqual(parseRoute('#/settings/sync'), { name: 'settings', section: 'sync' });
  assert.deepEqual(parseRoute('#/settings/unknown'), { name: 'settings' });
});

test('路由：返回层级与底栏高亮归属', () => {
  assert.deepEqual(parentOf({ name: 'chat', sessionId: 's1' }), { name: 'sessions' });
  assert.deepEqual(parentOf({ name: 'character', characterId: 'new' }), { name: 'characters' });
  assert.deepEqual(parentOf({ name: 'import' }), { name: 'characters' });
  assert.equal(parentOf({ name: 'sessions' }), undefined, '根页面没有上一级（交给系统退出）');
  // 设置三级：分区页一次返回回设置首页（L1），首页才是根
  assert.deepEqual(parentOf({ name: 'settings', section: 'sync' }), { name: 'settings' });
  assert.equal(parentOf({ name: 'settings' }), undefined);

  assert.equal(isRootRoute({ name: 'sessions' }), true);
  assert.equal(isRootRoute({ name: 'chat', sessionId: 's1' }), false);
  assert.equal(isRootRoute({ name: 'settings' }), true);
  assert.equal(isRootRoute({ name: 'settings', section: 'sync' }), false, '分区页要显示返回键');

  assert.equal(activeTabName({ name: 'chat', sessionId: 's1' }), 'sessions');
  assert.equal(activeTabName({ name: 'character', characterId: 'c1' }), 'characters');
  assert.equal(activeTabName({ name: 'import' }), 'characters');
  assert.equal(activeTabName({ name: 'settings' }), 'settings');
  assert.equal(activeTabName({ name: 'settings', section: 'sync' }), 'settings', '分区页仍高亮设置标签');
});

test('路由：底栏正好四个根标签（标签名是 i18n key，不是硬编码文案）', () => {
  assert.deepEqual(
    TABS.map((tab) => tab.label),
    ['tab.sessions', 'tab.characters', 'tab.lore', 'tab.settings'],
  );
  for (const tab of TABS) assert.equal(isRootRoute(tab.route), true);
});

test('路由：每个路由的 hash 都能解析回自己（新增路由漏写 parseRoute 会立刻失败）', () => {
  // 真机上踩过：`#/lore` 没进 parseRoute，于是点"世界书"标签时 URL 变了、界面却回到根路由，
  // 而且因为 hash 已经等于目标值，之后再点同一个标签会被"原地不动"判据直接跳过。
  const routes: Route[] = [
    { name: 'sessions' },
    { name: 'characters' },
    { name: 'lore' },
    { name: 'settings' },
    { name: 'settings', section: 'model' },
    { name: 'settings', section: 'sync' },
    { name: 'import' },
    { name: 'chat', sessionId: '01ABC' },
    { name: 'character', characterId: '01DEF' },
    { name: 'character', characterId: 'new' },
    { name: 'lorebook', lorebookId: '01GHI' },
  ];
  for (const route of routes) {
    const hash = routeToHash(route);
    assert.deepEqual(parseRoute(hash), route, `${hash} 应当解析回 ${route.name}`);
  }
});

// ---------------------------------------------------------------- 应用状态

async function storeWithData() {
  const repository = createMemoryRepository();
  const store = createAppStore(repository);
  await store.actions.refresh();
  const character = await store.actions.saveCharacter({
    name: '星野',
    description: '夜巡的守望者',
    firstMessage: '「进来吧，风会替你关门。」',
  });
  return { repository, store, character };
}

test('状态：refresh 拉起数据并把 status 置为 ready', async () => {
  const { store } = await storeWithData();
  const state = store.getState();
  assert.equal(state.status, 'ready');
  assert.deepEqual(state.characters.map((item) => item.name), ['星野']);
  assert.equal(state.error, undefined);
});

test('状态：新建会话后列表出现该会话，进入聊天能读到开场白', async () => {
  const { store, character } = await storeWithData();
  const session = await store.actions.createSession(character.id);

  assert.equal(store.getState().sessions[0]?.id, session.id);
  assert.equal(store.getState().sessions[0]?.messageCount, 1);

  await store.actions.loadMessages(session.id);
  const state = store.getState();
  assert.equal(state.activeSessionId, session.id);
  assert.equal(state.messages[0]?.content, '「进来吧，风会替你关门。」');
});

test('状态：发送消息会落库并刷新会话列表摘要', async () => {
  const { store, character } = await storeWithData();
  const session = await store.actions.createSession(character.id);

  await store.actions.send(session.id, '  风大吗  ');
  const state = store.getState();
  assert.deepEqual(
    state.messages.map((message) => `${message.role}:${message.content}`),
    ['assistant:「进来吧，风会替你关门。」', 'user:风大吗'],
    '两端空白应被裁掉',
  );
  assert.equal(state.sessions[0]?.lastMessage, '风大吗');
  assert.equal(state.sessions[0]?.messageCount, 2);
  assert.equal(state.busy, undefined, '操作结束后 busy 必须清掉');
});

test('状态：空消息不落库', async () => {
  const { store, character } = await storeWithData();
  const session = await store.actions.createSession(character.id);
  await store.actions.send(session.id, '   ');
  assert.equal(store.getState().messages.length, 1, '只有开场白');
});

test('状态：删除会话会清空当前消息并退出该会话', async () => {
  const { store, character } = await storeWithData();
  const session = await store.actions.createSession(character.id);
  await store.actions.loadMessages(session.id);

  await store.actions.deleteSession(session.id);
  const state = store.getState();
  assert.deepEqual(state.sessions, []);
  assert.deepEqual(state.messages, []);
  assert.equal(state.activeSessionId, undefined, '删掉的会话不能还留在 activeSessionId');
});

test('状态：校验失败会变成可见错误，而不是把应用留成空白', async () => {
  const { store } = await storeWithData();
  await assert.rejects(() => store.actions.saveCharacter({ name: '   ' }));
  const state = store.getState();
  assert.match(state.error ?? '', /角色名不能为空/);
  assert.equal(state.busy, undefined);
  assert.equal(state.characters.length, 1, '失败不应破坏已有数据');
});

test('状态：设置写入后立即反映在 state 里', async () => {
  const { store } = await storeWithData();
  await store.actions.setSetting('model.base_url', 'https://api.example.com/v1');
  assert.equal(store.getState().settings['model.base_url'], 'https://api.example.com/v1');
});

test('状态：订阅能收到状态变化，退订后不再收', async () => {
  const { store } = await storeWithData();
  const seen: number[] = [];
  const off = store.subscribe((state) => seen.push(state.characters.length));
  assert.equal(seen.length, 1, '订阅时立刻推一次当前状态');

  await store.actions.refresh();
  assert.ok(seen.length > 1);
  off();
  const before = seen.length;
  await store.actions.refresh();
  assert.equal(seen.length, before, '退订后不该再收到');
});
