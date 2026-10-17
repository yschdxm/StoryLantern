import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createLocalRepository, createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createMemoryRepository } from '../src/data/memory-repository.ts';
import { DataError, formatTime, isLocalEndpoint, isModelConfigured, previewOf, type Repository } from '../src/data/repository.ts';

/**
 * 同一套契约测试跑**两个实现**：内存（语义参考）与 op-log（M1 之后的真实路径）。
 *
 * op-log 那份是 M1 的关键证据：**同样的行为，但读取完全派生自 op 日志**。
 * 也就是说这些断言通过 ⇒ "日志是唯一事实源"不是口号，而是可执行的事实。
 */

interface ContractContext {
  readonly repo: Repository;
  /** 重建一个指向同一份数据的仓储（用于验证持久化）。 */
  reopen(): Promise<Repository>;
}

function contract(name: string, make: () => Promise<ContractContext>): void {
  test(`${name}：角色能保存、读回、更新与删除（删除会级联清会话与消息）`, async () => {
    const { repo } = await make();

    const created = await repo.characters.save({ name: '  星野  ', description: '夜巡的守望者' });
    assert.ok(created.id.length > 0, 'id 应当是非空字符串（跨设备唯一）');
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
    assert.equal(await repo.sessions.rename('nosuchsession', '不存在'), false);

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
    assert.equal(await repo.messages.update('nosuchmessage', 'x'), false);
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
    await capture(() => repo.characters.save({ id: 'nosuchcharacter', name: '存在吗' }));
    await capture(() => repo.sessions.create('nosuchcharacter'));
    await capture(() => repo.messages.append('somesession', 'narrator' as never, 'hi'));

    assert.deepEqual(codes, [
      'invalid-argument',
      'invalid-argument',
      'invalid-argument',
      'invalid-argument',
      'invalid-argument',
    ]);
  });

  test(`${name}：世界书与条目能保存、按角色筛选、删书带走条目，并且能重启后仍在`, async () => {
    const { repo, reopen } = await make();
    const character = await repo.characters.save({ name: '星野' });

    const shared = await repo.lorebooks.save({ name: '世界常识', description: '所有角色共用' });
    const bound = await repo.lorebooks.save({ name: '星野的书', characterIds: [character.id] });
    await repo.lorebooks.save({ name: '别人的书', characterIds: ['nobody'] });
    await repo.lorebooks.save({ name: '关掉的书', enabled: false });

    assert.equal(shared.characterIds.length, 0, '不绑定角色 = 全局');
    // 列表顺序不在契约里（两个实现各自按自己的更新时间排），因此两边都排序后比较
    assert.deepEqual(
      (await repo.lorebooks.list()).map((book) => book.name).sort(),
      ['世界常识', '别人的书', '关掉的书', '星野的书'].sort(),
    );

    // 按角色筛选：绑定的 + 全局的（顺序不重要，按名字比较）
    const forCharacter = (await repo.lorebooks.forCharacter(character.id)).map((book) => book.name).sort();
    assert.deepEqual(forCharacter, ['世界常识', '星野的书']);
    assert.deepEqual((await repo.lorebooks.forCharacter(undefined)).map((book) => book.name), ['世界常识']);

    // 条目：关键词会去空白、去重
    const withEntry = await repo.lorebooks.saveEntry({
      lorebookId: bound.id,
      keys: ['  铜铃 ', '铜铃', '隘口'],
      content: '铜铃是隘口的报信之物。',
      order: 5,
    });
    assert.deepEqual(withEntry.entries[0]?.keys, ['铜铃', '隘口'], '关键词去重且裁掉空白');
    assert.equal(withEntry.entries[0]?.order, 5);
    assert.equal(withEntry.entries[0]?.enabled, true);
    assert.equal(withEntry.entries[0]?.recursive, true, '默认允许递归');

    const entryId = withEntry.entries[0]?.id ?? '';
    const edited = await repo.lorebooks.saveEntry({ lorebookId: bound.id, id: entryId, content: '改过的正文', constant: true });
    assert.equal(edited.entries[0]?.content, '改过的正文');
    assert.equal(edited.entries[0]?.id, entryId, '更新保持同一个 id');

    // 校验：没有关键词又不是常量条目 → 无效
    await assert.rejects(
      () => repo.lorebooks.saveEntry({ lorebookId: bound.id, keys: [], content: '无关键词' }),
      (error: unknown) => (error as DataError).code === 'invalid-argument',
    );
    await assert.rejects(
      () => repo.lorebooks.save({ name: '   ' }),
      (error: unknown) => (error as DataError).code === 'invalid-argument',
    );

    // 重启（重放日志）后世界书与条目都还在
    const revived = await reopen();
    const revivedBook = await revived.lorebooks.get(bound.id);
    assert.equal(revivedBook?.entries.length, 1);
    assert.equal(revivedBook?.entries[0]?.content, '改过的正文');

    // 删除条目：书还在，条目没了
    const afterEntryRemoval = await repo.lorebooks.removeEntry(bound.id, entryId);
    assert.equal(afterEntryRemoval?.entries.length, 0);
    assert.equal(await repo.lorebooks.removeEntry(bound.id, entryId), undefined, '重复删除返回 undefined');

    // 删除世界书：条目一并不可见
    assert.equal(await repo.lorebooks.remove(bound.id), true);
    assert.equal(await repo.lorebooks.get(bound.id), undefined);
    assert.equal(await repo.lorebooks.remove(bound.id), false, '重复删除返回 false');
  });
}

// ---------------------------------------------------------------- 两个实现

contract('内存仓储（语义参考）', async () => {
  const repo = createMemoryRepository();
  return { repo, reopen: async () => repo };
});

contract('op-log 仓储（日志是唯一事实源）', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;
  return {
    repo,
    // 从同一份 op 日志再建一个仓储：等价于"重启应用后重放日志"
    reopen: async () => {
      const revived = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
      await revived.ready;
      return revived;
    },
  };
});

// ---------------------------------------------------------------- op-log 仓储特有的东西

test('op-log：重启后（重放日志）数据还在，且每条写入都进了日志', async () => {
  const kv = createMemoryKeyValue();
  const ports = createLocalOpPorts(kv);
  const first = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await first.ready;

  const character = await first.characters.save({ name: '星野', firstMessage: '「进来吧。」' });
  const session = await first.sessions.create(character.id);
  await first.messages.append(session.id, 'user', '风大吗');

  const before = await ports.ops.stats();
  // ADR-0011 后角色写卡片、旧字段进兼容草稿，op 条数不再固定：
  // 改为按 op 类型断言（角色 card.upsert + 开场白 stash.upsert + 会话 create + 开局配置 + 开场白/用户消息 append）
  const page = await ports.ops.list(0, 100);
  const types = page.rows.map((row) => (JSON.parse(row.line) as { type?: string }).type ?? '');
  assert.deepEqual(
    [...new Set(types)].sort(),
    ['card.upsert', 'message.append', 'session.create', 'session.setup', 'stash.upsert'],
    '角色写卡片与兼容草稿；建会话写会话、开局配置与开场白；用户消息单独一条',
  );
  assert.equal(before.count, page.rows.length, '统计条数与实际读出的行数一致');
  assert.equal(before.devices, 1, '所有 op 都带着本设备 id');

  // "重启"：同一份 op 日志，全新仓储
  const revived = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await revived.ready;
  const characters = await revived.characters.list();
  assert.deepEqual(characters.map((item) => item.name), ['星野']);

  const sessions = await revived.sessions.list();
  assert.equal(sessions[0]?.messageCount, 2);
  assert.equal(sessions[0]?.lastMessage, '风大吗');
  const messages = await revived.messages.list(session.id);
  assert.deepEqual(messages.map((message) => message.content), ['「进来吧。」', '风大吗']);
});

test('op-log：rebuild() 丢掉内存状态、只靠日志重建出同样的数据', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;

  const character = await repo.characters.save({ name: '星野' });
  const session = await repo.sessions.create(character.id);
  await repo.messages.append(session.id, 'assistant', '灯还亮着');

  const rebuilt = await repo.rebuild();
  assert.equal(rebuilt.characters, 1);
  assert.equal(rebuilt.sessions, 1);
  assert.equal(rebuilt.messages, 1, '重放后只剩那条真实写入的消息（这个角色没有开场白）');

  const sessions = await repo.sessions.list();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.characterName, '星野');
  assert.deepEqual((await repo.messages.list(session.id)).map((message) => message.content), ['灯还亮着']);
});

test('op-log：重复投递同一条 op 不会写第二遍（幂等）', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;

  await repo.characters.save({ name: '星野' });
  const stats = await ports.ops.stats();
  // 把日志里的行原样再追加一次：应当全部判为重复
  const page = await ports.ops.list(0, 100);
  const outcome = await ports.ops.append(page.rows.map((row) => row.line));
  assert.equal(outcome.appended, 0);
  assert.equal(outcome.duplicates, stats.count);

  const after = await ports.ops.stats();
  assert.equal(after.count, stats.count, '重复投递不该让日志变长');
  assert.deepEqual((await repo.characters.list()).map((item) => item.name), ['星野']);
});

test('op-log：日志里的坏行被隔离，应用仍然起得来（并在统计里可见）', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const good = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await good.ready;
  await good.characters.save({ name: '星野' });

  // 手工塞一条坏行：JSON 合法但结构不合法（缺 hlc/entity/payload），
  // 模拟同步或磁盘问题带来的损坏——解码会被隔离，而不是让应用起不来。
  const page = await ports.ops.list(0, 100);
  await ports.ops.append(['{"opId":"broken","deviceId":"x","schema":1,"type":"character.upsert"}']);

  const revived = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await revived.ready;
  assert.deepEqual((await revived.characters.list()).map((item) => item.name), ['星野'], '好数据不受影响');
  assert.equal((await revived.logStats()).corrupt, 1, '坏行数量要能被看到');
  assert.equal(page.rows.length, 1);
});

test('op-log：旧表数据能一次性迁移成 op，时间戳沿用原记录', async () => {
  const kv = createMemoryKeyValue();
  const ports = createLocalOpPorts(kv);
  const legacy = {
    characters: [
      {
        id: 1,
        name: '旧角色',
        description: '来自旧表',
        personality: '',
        scenario: '',
        firstMessage: '「旧开场白」',
        exampleDialogue: '',
        createdAt: 1_600_000_000_000,
        updatedAt: 1_600_000_100_000,
      },
    ],
    sessions: [{ id: 10, title: '旧会话', characterId: 1, createdAt: 1_600_000_200_000, updatedAt: 1_600_000_200_000 }],
    messages: [
      { id: 100, sessionId: 10, role: 'user', content: '旧消息', status: 'done', createdAt: 1_600_000_300_000 },
      { id: 101, sessionId: 10, role: 'assistant', content: '旧回复', status: 'done', createdAt: 1_600_000_400_000 },
    ],
  };

  const repo = createOpLogRepository({
    ops: ports.ops,
    settings: ports.settings,
    deviceId: 'device-a',
    loadLegacy: async () => legacy,
  });
  await repo.ready;

  const characters = await repo.characters.list();
  assert.deepEqual(characters.map((item) => item.name), ['旧角色']);
  assert.equal(characters[0]?.createdAt, 1_600_000_000_000, '创建时间沿用旧记录');

  const sessions = await repo.sessions.list();
  assert.equal(sessions[0]?.title, '旧会话');
  assert.equal(sessions[0]?.characterName, '旧角色');
  assert.equal(sessions[0]?.messageCount, 2);

  const messages = await repo.messages.list(sessions[0]?.id ?? '');
  assert.deepEqual(messages.map((message) => message.content), ['旧消息', '旧回复']);
  assert.equal(messages[0]?.createdAt, 1_600_000_300_000, '历史消息的原始时间要保住');

  // 迁移只做一次：日志非空后再给一份旧表也不会重复导入
  const again = createOpLogRepository({
    ops: ports.ops,
    settings: ports.settings,
    deviceId: 'device-a',
    loadLegacy: async () => legacy,
  });
  await again.ready;
  assert.equal((await again.characters.list()).length, 1, '不该重复迁移');
});

test('op-log：settings 走宿主配置，不进 op 日志（密钥不参与同步）', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;

  await repo.settings.set('model.api_key', 'sk-secret');
  assert.equal((await repo.settings.get('model.api_key')), 'sk-secret');

  const lines = (await ports.ops.list(0, 100)).rows.map((row) => row.line).join('\n');
  assert.ok(!lines.includes('sk-secret'), '密钥绝不能出现在 op 日志里');
  assert.equal((await ports.ops.stats()).count, 0, '设置不产生 op');
});
﻿
