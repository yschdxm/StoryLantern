import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createOpLogRepository, type OpLogRepository } from '../src/data/op-repository.ts';
import { DataError } from '../src/data/repository.ts';
import type {
  CardDocument,
  CharacterCard,
  CompatStashEntry,
  SessionSetup,
  WorldPackManifest,
} from '../../../packages/cards/src/index.ts';

/**
 * 卡片模型五个 op 仓储的契约测试。
 *
 * 钉住的是**行为**而不是实现：读派生自物化状态、写先落盘再改内存、
 * 生产者侧校验在写 op 之前发生（非法输入不留下任何日志噪音）。
 */

interface Harness {
  repo: OpLogRepository;
  ports: ReturnType<typeof createLocalOpPorts>;
}

function newRepository(): Harness {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  return { repo, ports };
}

function isDataError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof DataError && error.code === code;
}

function characterCard(id = 'c1', overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    card_type: 'character',
    meta: {
      id,
      schema: 'rolecard/v1',
      name: '星野',
      version: '1.0.0',
      language: 'zh-CN',
      rating: 'general',
      description: '夜巡的守望者',
    },
    identity: { name: '星野', background: '夜巡的守望者' },
    persona: {
      summary: '话少',
      traits: ['沉默'],
      knowledge_boundary: '不知道王都的事',
      ability_boundary: '不会魔法',
    },
    speech: { style: '简短' },
    ...overrides,
  };
}

/** 打开一个带会话的仓储：会话仍走旧的 session.create（应用侧尚未切换）。 */
async function repositoryWithSession(): Promise<Harness & { sessionId: string }> {
  const harness = newRepository();
  await harness.repo.ready;
  const legacy = await harness.repo.characters.save({ name: '旧角色' });
  const session = await harness.repo.sessions.create(legacy.id);
  return { ...harness, sessionId: session.id };
}

test('卡片：保存后可读回；同 id 再存是更新而不是新增', async () => {
  const { repo } = newRepository();
  await repo.ready;

  const saved = await repo.cards.save(characterCard());
  assert.equal(saved.meta.id, 'c1');
  assert.equal((await repo.cards.list()).length, 1);
  assert.equal((await repo.cards.get('c1'))?.meta.name, '星野');
  assert.equal(await repo.cards.get('nope'), undefined);
  assert.deepEqual(await repo.cards.list('lore'), [], '按类型过滤（这里只有角色卡）');

  const updated = await repo.cards.save(
    characterCard('c1', {
      meta: { ...characterCard().meta, name: '星野·改' },
      identity: { name: '星野·改', background: '夜巡的守望者' },
    }),
  );
  assert.equal(updated.meta.name, '星野·改');
  const listed = await repo.cards.list('character');
  assert.equal(listed.length, 1, '同 id 是整文档更新，不是新增一份');
  assert.equal(listed[0]?.meta.name, '星野·改');
});

test('卡片：删除后 list/get 都不含；新 HLC 的再次保存可以复活', async () => {
  const { repo } = newRepository();
  await repo.ready;
  await repo.cards.save(characterCard());

  assert.equal(await repo.cards.remove('c1'), true);
  assert.deepEqual(await repo.cards.list(), []);
  assert.equal(await repo.cards.get('c1'), undefined);
  assert.equal(await repo.cards.remove('c1'), false, '重复删除返回 false');

  const revived = await repo.cards.save(characterCard('c1', { meta: { ...characterCard().meta, name: '复活的星野' } }));
  assert.equal(revived.meta.name, '复活的星野');
  assert.equal((await repo.cards.list()).length, 1);
});

test('卡片：非法卡抛 DataError，且不写入任何 op', async () => {
  const { repo, ports } = newRepository();
  await repo.ready;
  const before = (await ports.ops.stats()).count;

  const { id: _dropped, ...metaWithoutId } = characterCard().meta;
  const invalid = { ...characterCard(), meta: metaWithoutId } as unknown as CardDocument;

  await assert.rejects(repo.cards.save(invalid), isDataError('invalid-argument'), '缺 meta.id 必须被拦住');
  assert.equal((await ports.ops.stats()).count, before, '被拒绝的写入不能留下 op（日志是事实源）');
  assert.deepEqual(await repo.cards.list(), []);
});

test('开局配置：保存/读取；会话不存在或成员为空都抛 DataError', async () => {
  const { repo, sessionId } = await repositoryWithSession();
  const setup: SessionSetup = { characters: ['c1'], premise: '雨夜边境酒馆', opening_mode: 'auto', origin: 'user' };

  const saved = await repo.setups.save(sessionId, setup);
  assert.equal(saved.premise, '雨夜边境酒馆');
  assert.deepEqual((await repo.setups.get(sessionId))?.characters, ['c1']);
  assert.equal(await repo.setups.get('nosuchsession'), undefined);

  await assert.rejects(repo.setups.save('nosuchsession', setup), isDataError('invalid-argument'));
  await assert.rejects(repo.setups.save(sessionId, { ...setup, characters: [] }), isDataError('invalid-argument'));
});

test('运行时：add 增量派生正确；字符串变量不能用 add；夹取后写进 op 并在返回值体现', async () => {
  const { repo, ports, sessionId } = await repositoryWithSession();
  const card = characterCard('c1', {
    state: {
      schema: {
        affection: { type: 'integer', default: 0, min: 0, max: 100 },
        mood: { type: 'string', default: '平静' },
      },
      update_policy: { allow_llm_patch: true, require_engine_validation: true, max_delta_per_turn: 10 },
    },
  });
  await repo.cards.save(card);
  await repo.setups.save(sessionId, {
    characters: ['c1'],
    premise: '雨夜',
    opening_mode: 'auto',
    origin: 'user',
    init_state: { c1: { affection: 95 } },
  });

  const runtime = await repo.runtime.patch({
    sessionId,
    source: 'llm',
    deltas: [{ kind: 'state', scope: { kind: 'character', id: 'c1' }, name: 'affection', op: 'add', value: 40 }],
  });
  // 95 + 40 → 单回合上限 10 → 触顶 100：实际增量 5
  assert.equal(runtime.variables['character:c1']?.['affection'], 100);
  const patch = repo.currentMaterializer().state.runtimePatches[sessionId]?.[0];
  const delta = patch?.deltas[0];
  assert.ok(delta?.kind === 'state' && delta.op === 'add');
  assert.equal(delta.value, 5, '写进 op 的是夹取后的增量，重放不再改变数值');

  const before = (await ports.ops.stats()).count;
  await assert.rejects(
    repo.runtime.patch({
      sessionId,
      source: 'llm',
      deltas: [{ kind: 'state', scope: { kind: 'character', id: 'c1' }, name: 'mood', op: 'add', value: 3 }],
    }),
    isDataError('invalid-argument'),
    '字符串变量不能做数值加法',
  );
  assert.equal((await ports.ops.stats()).count, before, '校验失败不写 op');

  await assert.rejects(
    repo.runtime.patch({
      sessionId,
      source: 'llm',
      deltas: [{ kind: 'state', scope: { kind: 'character', id: 'c1' }, name: 'affection', op: 'replace', value: 500 }],
    }),
    isDataError('invalid-argument'),
    'replace 超出 max 必须被拦住',
  );

  const current = await repo.runtime.patch({ sessionId, source: 'engine', deltas: [] });
  assert.equal(current.variables['character:c1']?.['affection'], 100);
  assert.equal((await ports.ops.stats()).count, before, '空补丁不写空 op');
  assert.equal((await repo.runtime.get(sessionId)).variables['character:c1']?.['affection'], 100);
});

test('运行时：会话不存在抛 DataError（get 仍可派生空状态）', async () => {
  const { repo } = newRepository();
  await repo.ready;
  await assert.rejects(
    repo.runtime.patch({ sessionId: 'nope', source: 'user', deltas: [] }),
    isDataError('invalid-argument'),
  );
  assert.deepEqual((await repo.runtime.get('nope')).variables, { session: {} });
});

test('世界包与兼容草稿：基本读写与删除', async () => {
  const { repo } = newRepository();
  await repo.ready;

  const pack: WorldPackManifest = {
    schema: 'worldpack/v1',
    id: 'p1',
    name: '边境城',
    version: '1.0.0',
    language: 'zh-CN',
    card_ids: ['lore-1'],
  };
  assert.equal((await repo.packs.save(pack)).name, '边境城');
  assert.deepEqual((await repo.packs.list()).map((item) => item.id), ['p1']);
  assert.equal(await repo.packs.remove('p1'), true);
  assert.deepEqual(await repo.packs.list(), []);
  assert.equal(await repo.packs.remove('p1'), false);

  const entry: CompatStashEntry = {
    schema: 'stash/v1',
    id: 'legacy-stash-scenario-c1',
    character_id: 'c1',
    kind: 'scenario',
    text: '雨夜边境酒馆',
    source: 'legacy:character.scenario',
    created_at: 1_700_000_000_000,
  };
  assert.equal((await repo.stash.save(entry)).text, '雨夜边境酒馆');
  assert.equal((await repo.stash.list()).length, 1);
  assert.equal((await repo.stash.list('c1')).length, 1);
  assert.deepEqual(await repo.stash.list('c2'), []);
  assert.equal(await repo.stash.remove(entry.id), true);
  assert.deepEqual(await repo.stash.list(), []);
  assert.equal(await repo.stash.remove(entry.id), false);
});
