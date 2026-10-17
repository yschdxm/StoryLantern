import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupOf } from '../../../packages/oplog/src/index.ts';
import type { CharacterCard, SessionSetup } from '../../../packages/cards/src/index.ts';
import { applyDraftToCard } from '../src/data/character-compat.ts';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { DataError } from '../src/data/repository.ts';

/**
 * 会话创建（SessionSetup，ADR-0011）的仓储契约：
 *  - 成员校验与顺序、`setup.characters` 以入参为准；
 *  - 开场消息只由模式决定（designated 才写；文本优先，其次角色开场白草稿首段）；
 *  - `mounts: {}` 与不传等价（全库）；缺成员时一条 op 都不写。
 */

function makeRepo() {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  return { ports, repo: createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' }) };
}

function characterCard(name: string, summary: string): CharacterCard {
  return applyDraftToCard(undefined, {
    name,
    description: `${name}的一句话简介`,
    background: `${name}的背景故事`,
    personalitySummary: summary,
    traits: ['克制'],
    speechStyle: '短句。',
    knowledgeBoundary: '不知道山外的事。',
    abilityBoundary: '能在暴雪里辨路。',
  });
}

async function saveCharacter(repo: ReturnType<typeof makeRepo>['repo'], name: string, summary = '守夜人'): Promise<string> {
  const saved = await repo.cards.save(characterCard(name, summary));
  return saved.meta.id;
}

function selfSetup(overrides: Partial<SessionSetup> = {}): SessionSetup {
  return { characters: [], premise: '', opening_mode: 'self', origin: 'user', ...overrides };
}

test('一成员：落 session.list、setup 成员/处境/模式与入参一致、标题默认角色名', async () => {
  const { repo } = makeRepo();
  await repo.ready;
  const id = await saveCharacter(repo, '星野');

  const session = await repo.sessions.createWithSetup?.({
    characterIds: [id],
    setup: selfSetup({ characters: ['传错的 id'], premise: '雨夜，你推开边境酒馆的门。' }),
  });
  assert.ok(session !== undefined);
  assert.equal(session.title, '星野', '标题留空 = 第一个成员名');

  const listed = await repo.sessions.list();
  assert.deepEqual(listed.map((item) => item.id), [session.id]);
  const setup = setupOf(repo.currentMaterializer().state, session.id)?.setup;
  assert.ok(setup !== undefined, '必须写入 session.setup');
  assert.deepEqual(setup.characters, [id], 'setup.characters 以入参重写，不被调用方传错影响');
  assert.equal(setup.premise, '雨夜，你推开边境酒馆的门。');
  assert.equal(setup.opening_mode, 'self');
  assert.equal(setup.mounts, undefined, '不传 = 全库可用');
  assert.deepEqual(await repo.messages.list(session.id), [], 'self 不写开场消息');
});

test('多成员：setup.characters 保持入参顺序，标题取第一个成员', async () => {
  const { repo } = makeRepo();
  await repo.ready;
  const first = await saveCharacter(repo, '星野');
  const second = await saveCharacter(repo, '白露');

  const session = await repo.sessions.createWithSetup?.({
    characterIds: [second, first],
    setup: selfSetup(),
  });
  assert.ok(session !== undefined);
  assert.equal(session.title, '白露');
  const setup = setupOf(repo.currentMaterializer().state, session.id)?.setup;
  assert.deepEqual(setup?.characters, [second, first]);
});

test('designated + opening_input：写一条 assistant 消息，内容正确', async () => {
  const { repo } = makeRepo();
  await repo.ready;
  const id = await saveCharacter(repo, '星野');

  const session = await repo.sessions.createWithSetup?.({
    characterIds: [id],
    setup: selfSetup({ opening_mode: 'designated', opening_speaker: id, opening_input: '「进来吧，风会替你关门。」' }),
  });
  assert.ok(session !== undefined);
  const messages = await repo.messages.list(session.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, 'assistant');
  assert.equal(messages[0]?.content, '「进来吧，风会替你关门。」');
  const setup = setupOf(repo.currentMaterializer().state, session.id)?.setup;
  assert.equal(setup?.opening_speaker, id);
  assert.equal(setup?.opening_input, '「进来吧，风会替你关门。」');
});

test('designated 不带文本：用角色开场白草稿的首段（分隔符之前）', async () => {
  const { repo } = makeRepo();
  await repo.ready;
  // 旧字段经兼容层写入卡片 + 开场白草稿（firstMessage + 备选）
  const character = await repo.characters.save({
    name: '星野',
    firstMessage: '草稿第一句',
    alternateGreetings: ['草稿第二句'],
  });

  const session = await repo.sessions.createWithSetup?.({
    characterIds: [character.id],
    setup: selfSetup({ opening_mode: 'designated', opening_speaker: character.id }),
  });
  assert.ok(session !== undefined);
  const messages = await repo.messages.list(session.id);
  assert.deepEqual(messages.map((message) => message.content), ['草稿第一句']);
  assert.equal(messages[0]?.role, 'assistant');
});

test('self / auto：都不写开场消息；auto 按 self 落地（不假装生成过）', async () => {
  const { repo } = makeRepo();
  await repo.ready;
  const id = await saveCharacter(repo, '星野');

  const self = await repo.sessions.createWithSetup?.({ characterIds: [id], setup: selfSetup({ opening_mode: 'self' }) });
  assert.ok(self !== undefined);
  assert.deepEqual(await repo.messages.list(self.id), []);

  const auto = await repo.sessions.createWithSetup?.({ characterIds: [id], setup: selfSetup({ opening_mode: 'auto' }) });
  assert.ok(auto !== undefined, 'auto 不应抛错（界面暂不提供，仓储按 self 处理）');
  assert.deepEqual(await repo.messages.list(auto.id), []);
  assert.equal(setupOf(repo.currentMaterializer().state, auto.id)?.setup.opening_mode, 'self');
});

test('成员不存在：抛 DataError 且一条 op 都不写', async () => {
  const { ports, repo } = makeRepo();
  await repo.ready;
  const before = (await ports.ops.stats()).count;

  await assert.rejects(
    () =>
      repo.sessions.createWithSetup?.({
        characterIds: ['不存在的角色'],
        setup: selfSetup(),
      }) ?? Promise.resolve(undefined),
    (cause: unknown) => cause instanceof DataError && cause.code === 'invalid-argument',
  );
  assert.equal((await ports.ops.stats()).count, before, '校验失败必须在落盘之前');
  assert.deepEqual(await repo.sessions.list(), []);
});

test('mounts：空对象与不传等价（全库）；非空时原样保存', async () => {
  const { repo } = makeRepo();
  await repo.ready;
  const id = await saveCharacter(repo, '星野');

  const empty = await repo.sessions.createWithSetup?.({
    characterIds: [id],
    setup: selfSetup({ mounts: {} }),
  });
  assert.ok(empty !== undefined);
  assert.equal(setupOf(repo.currentMaterializer().state, empty.id)?.setup.mounts, undefined, '空 mounts = 全库');

  const mounted = await repo.sessions.createWithSetup?.({
    characterIds: [id],
    setup: selfSetup({ mounts: { pack_ids: ['pack-1'], card_ids: ['card-1'] } }),
  });
  assert.ok(mounted !== undefined);
  assert.deepEqual(setupOf(repo.currentMaterializer().state, mounted.id)?.setup.mounts, {
    pack_ids: ['pack-1'],
    card_ids: ['card-1'],
  });
});
