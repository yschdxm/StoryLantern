import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TauriBridge } from '../../../packages/wire/src/tauri.ts';
import { createTauriTransport } from '../../../packages/wire/src/tauri.ts';
import { createHostRepository } from '../src/data/host-repository.ts';
import { createLocalRepository, createMemoryKeyValue, loadState } from '../src/data/local-repository.ts';
import { createMemoryRepository } from '../src/data/memory-repository.ts';
import { DataError, formatTime, previewOf, type Repository } from '../src/data/repository.ts';

/**
 * 同一套契约测试跑**三个实现**：内存（语义参考）、localStorage（持久化）、宿主（wire→Rust）。
 *
 * 为什么必须这样测：这三个实现行为一旦分叉，界面就会"在手机上对、在浏览器里错"，
 * 而这类 bug 最难查。契约测试把"行为一致"变成可执行的断言，而不是口头约定。
 */

interface ContractContext {
  readonly repo: Repository;
  /** 重建一个指向同一份数据的仓储（用于验证持久化）。宿主的实现直接返回同一个。 */
  reopen(): Promise<Repository>;
}

function contract(name: string, make: () => Promise<ContractContext>): void {
  test(`${name}：角色能保存、读回、更新与删除（删除会级联清会话与消息）`, async () => {
    const { repo } = await make();

    const created = await repo.characters.save({ name: '  星野  ', description: '夜巡的守望者' });
    assert.ok(created.id > 0);
    assert.equal(created.name, '星野', '名字两端空白应被裁掉');
    assert.equal(created.createdAt > 0, true);
    assert.equal(created.createdAt, created.updatedAt);

    const listed = await repo.characters.list();
    assert.deepEqual(listed.map((item) => item.name), ['星野']);
    assert.equal((await repo.characters.get(created.id))?.description, '夜巡的守望者');

    const updated = await repo.characters.save({ id: created.id, name: '星野·改', scenario: '雪线之上' });
    assert.equal(updated.id, created.id, '更新必须保持同一个 id');
    assert.equal(updated.name, '星野·改');
    assert.equal(updated.scenario, '雪线之上');
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(updated.updatedAt >= created.updatedAt);

    const session = await repo.sessions.create(created.id);
    await repo.messages.append(session.id, 'user', '在吗');

    assert.equal(await repo.characters.remove(created.id), true);
    assert.deepEqual(await repo.characters.list(), []);
    assert.deepEqual(await repo.sessions.list(), [], '会话应随角色一起删除');
    assert.deepEqual(await repo.messages.list(session.id), [], '消息应随会话一起删除');
    assert.equal(await repo.characters.remove(created.id), false, '重复删除返回 false');
  });

  test(`${name}：会话创建会写入开场白，列表带角色名、条数与最后一条`, async () => {
    const { repo } = await make();
    const character = await repo.characters.save({
      name: '星野',
      firstMessage: '「进来吧，风会替你关门。」',
    });

    const session = await repo.sessions.create(character.id);
    assert.equal(session.title, '星野', '标题默认取角色名');
    assert.equal(session.characterName, '星野');
    assert.equal(session.messageCount, 1, '开场白算一条消息');

    const messages = await repo.messages.list(session.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, 'assistant');
    assert.equal(messages[0]?.content, '「进来吧，风会替你关门。」');
    assert.equal(messages[0]?.status, 'done');

    await repo.messages.append(session.id, 'user', '路上还顺利吗');
    const listed = await repo.sessions.list();
    assert.equal(listed[0]?.messageCount, 2);
    assert.equal(listed[0]?.lastMessage, '路上还顺利吗');

    assert.equal(await repo.sessions.rename(session.id, '隘口之夜'), true);
    assert.equal((await repo.sessions.list())[0]?.title, '隘口之夜');
    assert.equal(await repo.sessions.rename(9999, '不存在'), false);

    assert.equal(await repo.sessions.remove(session.id), true);
    assert.deepEqual(await repo.messages.list(session.id), [], '删会话要带走消息');
  });

  test(`${name}：消息按时间正序，可更新内容与状态`, async () => {
    const { repo } = await make();
    const character = await repo.characters.save({ name: '星野' });
    const session = await repo.sessions.create(character.id);

    const first = await repo.messages.append(session.id, 'user', '第一句');
    const second = await repo.messages.append(session.id, 'assistant', '第二句');
    const third = await repo.messages.append(session.id, 'user', '第三句');

    const messages = await repo.messages.list(session.id);
    assert.deepEqual(messages.map((message) => message.content), ['第一句', '第二句', '第三句']);
    assert.equal(messages[0]?.id, first.id);
    assert.equal(messages[2]?.id, third.id);

    assert.equal(await repo.messages.update(second.id, '第二句（改）', 'error'), true);
    const reloaded = await repo.messages.list(session.id);
    assert.equal(reloaded[1]?.content, '第二句（改）');
    assert.equal(reloaded[1]?.status, 'error');

    assert.equal(await repo.messages.remove(third.id), true);
    assert.equal((await repo.messages.list(session.id)).length, 2);
    assert.equal(await repo.messages.update(9999, 'x'), false);
  });

  test(`${name}：设置可读写；角色/会话/消息的校验错误码一致`, async () => {
    const { repo } = await make();

    await repo.settings.set('model.name', 'deepseek-chat');
    assert.equal(await repo.settings.get('model.name'), 'deepseek-chat');
    assert.equal(await repo.settings.get('nope'), undefined);
    assert.equal((await repo.settings.all())['model.name'], 'deepseek-chat');

    const codes: string[] = [];
    const capture = async (action: () => Promise<unknown>): Promise<void> => {
      try {
        await action();
        codes.push('(no-error)');
      } catch (cause) {
        codes.push(cause instanceof DataError ? cause.code : `(not-DataError:${String(cause)})`);
      }
    };

    await capture(() => repo.characters.save({ name: '   ' }));
    await capture(() => repo.characters.save({ name: 'x'.repeat(61) }));
    await capture(() => repo.characters.save({ id: 4242, name: '存在吗' }));
    await capture(() => repo.sessions.create(4242));
    await capture(() => repo.messages.append(1, 'narrator' as never, 'hi'));

    assert.deepEqual(codes, [
      'invalid-argument',
      'invalid-argument',
      'invalid-argument',
      'invalid-argument',
      'invalid-argument',
    ]);
  });
}

// ---------------------------------------------------------------- 三个实现

contract('内存仓储（语义参考）', async () => {
  const repo = createMemoryRepository();
  return { repo, reopen: async () => repo };
});

contract('localStorage 仓储', async () => {
  const store = createMemoryKeyValue();
  const repo = createLocalRepository(store);
  return {
    repo,
    // 从同一份键值再建一个：等价于"关掉页面再打开"
    reopen: async () => createLocalRepository(store),
  };
});

/** 假宿主：按 Rust 侧协议实现同样的语义（委托给内存仓储），用来验证宿主仓储的翻译层。 */
function createFakeRustHost(): TauriBridge {
  const backing = createMemoryRepository();
  const services = [
    { name: 'characters', description: '', methods: [{ name: 'list', kind: 'call', description: '' }] },
    { name: 'sessions', description: '', methods: [{ name: 'list', kind: 'call', description: '' }] },
    { name: 'messages', description: '', methods: [{ name: 'list', kind: 'call', description: '' }] },
    { name: 'settings', description: '', methods: [{ name: 'list', kind: 'call', description: '' }] },
    { name: 'store', description: '', methods: [{ name: 'probe', kind: 'call', description: '' }] },
  ];

  return {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (command === 'wire_manifest') return { services } as T;
      if (command === 'wire_stream_close') return null as T;
      if (command !== 'wire_invoke') throw { code: 'unknown-command', message: command };

      const service = String(args?.['service'] ?? '');
      const method = String(args?.['method'] ?? '');
      const callArgs = (args?.['args'] as unknown[]) ?? [];
      try {
        const handler = async (): Promise<unknown> => {
          if (service === 'characters') {
            if (method === 'list') return backing.characters.list();
            if (method === 'get') return (await backing.characters.get(Number(callArgs[0]))) ?? null;
            if (method === 'save') return backing.characters.save(callArgs[0] as never);
            if (method === 'delete') return { removed: await backing.characters.remove(Number(callArgs[0])) };
          }
          if (service === 'sessions') {
            if (method === 'list') return backing.sessions.list();
            if (method === 'create') return backing.sessions.create(Number(callArgs[0]), String(callArgs[1] ?? ''));
            if (method === 'rename') return { renamed: await backing.sessions.rename(Number(callArgs[0]), String(callArgs[1])) };
            if (method === 'delete') return { removed: await backing.sessions.remove(Number(callArgs[0])) };
          }
          if (service === 'messages') {
            if (method === 'list') return backing.messages.list(Number(callArgs[0]));
            if (method === 'append') {
              return backing.messages.append(Number(callArgs[0]), callArgs[1] as never, String(callArgs[2]), callArgs[3] as never);
            }
            if (method === 'update') return { updated: await backing.messages.update(Number(callArgs[0]), String(callArgs[1]), callArgs[2] as never) };
            if (method === 'delete') return { removed: await backing.messages.remove(Number(callArgs[0])) };
          }
          if (service === 'settings') {
            if (method === 'get') return { value: (await backing.settings.get(String(callArgs[0]))) ?? null };
            if (method === 'set') {
              await backing.settings.set(String(callArgs[0]), String(callArgs[1]));
              return { saved: true };
            }
            if (method === 'all') return backing.settings.all();
          }
          if (service === 'store' && method === 'probe') return backing.probe?.();
          throw { code: 'unknown-method', message: `${service}.${method}` };
        };
        return (await handler()) as T;
      } catch (cause) {
        // Tauri 的 command 语义：失败时 reject，载荷是 {code,message}
        if (cause instanceof DataError) throw { code: cause.code, message: cause.message };
        throw cause;
      }
    },
    async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      void event;
      void handler;
      return () => undefined;
    },
  };
}

contract('宿主仓储（wire→Rust/SQLite 协议）', async () => {
  const repo = createHostRepository(createTauriTransport({ bridge: createFakeRustHost() }));
  return { repo, reopen: async () => repo };
});

// ---------------------------------------------------------------- 各实现特有的东西

test('localStorage 仓储：数据真的落盘，重新打开页面后还在', async () => {
  const store = createMemoryKeyValue();
  const first = createLocalRepository(store);
  const character = await first.characters.save({ name: '星野', firstMessage: '「进来吧。」' });
  const session = await first.sessions.create(character.id);
  await first.messages.append(session.id, 'user', '风大吗');

  // 模拟"关掉页面再打开"：同一份 localStorage，全新的仓储实例
  const reopened = createLocalRepository(store);
  const characters = await reopened.characters.list();
  assert.deepEqual(characters.map((item) => item.name), ['星野']);

  const sessions = await reopened.sessions.list();
  assert.equal(sessions[0]?.messageCount, 2);
  assert.equal(sessions[0]?.lastMessage, '风大吗');
  const messages = await reopened.messages.list(session.id);
  assert.deepEqual(messages.map((message) => message.content), ['「进来吧。」', '风大吗']);
  assert.equal(await reopened.characters.get(character.id) !== undefined, true);
});

test('localStorage 仓储：坏数据不把应用卡死（当作空状态）', async () => {
  const store = createMemoryKeyValue();
  store.write('storylantern.state.v1', '{ 这不是 JSON');
  assert.deepEqual(loadState(store), {
    characters: [],
    sessions: [],
    messages: [],
    settings: {},
    sequence: 0,
  });

  store.write('storylantern.state.v1', JSON.stringify({ characters: 'nope' }));
  assert.deepEqual(loadState(store).characters, []);
});

test('宿主仓储：宿主拒绝时错误码原样传到界面（不吞、不换码）', async () => {
  const bridge = createFakeRustHost();
  const repo = createHostRepository(createTauriTransport({ bridge }));
  await assert.rejects(() => repo.characters.save({ name: '   ' }), (error: unknown) => {
    assert.ok(error instanceof DataError);
    assert.equal(error.code, 'invalid-argument');
    assert.match(error.message, /角色名不能为空/);
    return true;
  });
});

test('宿主仓储：probe 暴露宿主存储信息（浏览器实现给的是降级值）', async () => {
  const bridge = createFakeRustHost();
  const host = createHostRepository(createTauriTransport({ bridge }));
  const probe = await host.probe?.();
  assert.equal(probe?.journalMode, '—', '内存兜底的假宿主没有真 SQLite');
  assert.equal(probe?.writable, true);

  const browser = createMemoryRepository();
  assert.equal((await browser.probe?.())?.path.includes('没有宿主数据库'), true);
});

// ---------------------------------------------------------------- 展示辅助

test('时间与会话预览的展示规则', () => {
  const now = new Date('2026-10-14T12:00:00').getTime();
  assert.equal(formatTime(0), '');
  assert.equal(formatTime(now - 30_000, now), '刚刚');
  assert.equal(formatTime(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(formatTime(new Date('2026-10-14T09:05:00').getTime(), now), '09:05');
  assert.equal(formatTime(new Date('2026-10-13T22:00:00').getTime(), now), '昨天');
  assert.equal(formatTime(new Date('2026-10-08T10:00:00').getTime(), now), '10 月 8 日');

  assert.equal(previewOf('  '), '还没有消息');
  assert.equal(previewOf('一\n二  三'), '一 二 三');
  assert.equal(previewOf('x'.repeat(80)).length, 61);
});
