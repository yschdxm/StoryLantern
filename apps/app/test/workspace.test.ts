import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../src/app/state.ts';
import { loadWorkspace, mountedIdsOf } from '../src/app/workspace.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import type { LoreCard } from '../../../packages/cards/src/index.ts';

/**
 * 工作区激活：库级停用 / 资源池挂载 / 会话例外，三者都必须反映到"参与装配的卡片集合"上，
 * 并且把原因带回给请求面板（用户要能问出"这张卡为什么不生效"）。
 */

function loreCard(id: string, key: string): LoreCard {
  return {
    card_type: 'lore',
    meta: {
      id,
      schema: 'lore/v1',
      name: key,
      version: '1.0.0',
      language: 'zh-CN',
      rating: 'general',
      description: '测试用典籍',
    },
    kind: 'other',
    content: `${key}的正文`,
    keys: [key],
  };
}

async function makeRepo() {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;
  return repo;
}

async function stateOf(repo: Awaited<ReturnType<typeof makeRepo>>, sessionId: string): Promise<AppState> {
  return {
    status: 'ready',
    characters: await repo.characters.list(),
    sessions: await repo.sessions.list(),
    messages: await repo.messages.list(sessionId),
    lorebooks: await repo.lorebooks.list(),
    memories: [],
    facts: [],
    settings: {},
  };
}

test('工作区：库级停用的卡片不参与，并带回原因', async () => {
  const repo = await makeRepo();
  const character = await repo.characters.save({ name: '星野' });
  const session = await repo.sessions.create(character.id);
  await repo.cards!.save(loreCard('l1', '铜铃'));
  await repo.cards!.setEnabled('l1', false);

  const workspace = await loadWorkspace(repo, await stateOf(repo, session.id), session.id);
  assert.equal(
    workspace.cards.some((card) => card.meta.id === 'l1'),
    false,
  );
  assert.deepEqual(
    workspace.inactive.find((entry) => entry.id === 'l1'),
    { id: 'l1', kind: 'lore', code: 'library-disabled' },
  );
});

test('工作区：挂载了资源池后，池外的典籍不参与；池内的参与', async () => {
  const repo = await makeRepo();
  const character = await repo.characters.save({ name: '星野' });
  const session = await repo.sessions.create(character.id);
  await repo.cards!.save(loreCard('inside', '铜铃'));
  await repo.cards!.save(loreCard('outside', '铁马'));
  await repo.packs!.save({
    schema: 'worldpack/v1',
    id: 'pack-1',
    name: '边境',
    version: '1.0.0',
    language: 'zh-CN',
    card_ids: ['inside'],
  });
  const setup = await repo.setups!.get(session.id);
  assert.ok(setup !== undefined);
  await repo.setups!.save(session.id, { ...setup, mounts: { pack_ids: ['pack-1'] } });

  const workspace = await loadWorkspace(repo, await stateOf(repo, session.id), session.id);
  const activeIds = workspace.cards.map((card) => card.meta.id);
  assert.ok(activeIds.includes('inside'), '池内的典籍参与');
  assert.equal(activeIds.includes('outside'), false, '池外的典籍不参与');
  assert.deepEqual(
    workspace.inactive.find((entry) => entry.id === 'outside'),
    { id: 'outside', kind: 'lore', code: 'not-mounted' },
  );
});

test('工作区：会话例外可以关掉一张本来在场的卡', async () => {
  const repo = await makeRepo();
  const character = await repo.characters.save({ name: '星野' });
  const session = await repo.sessions.create(character.id);
  const setup = await repo.setups!.get(session.id);
  assert.ok(setup !== undefined);
  await repo.setups!.save(session.id, { ...setup, overrides: { [character.id]: false } });

  const workspace = await loadWorkspace(repo, await stateOf(repo, session.id), session.id);
  assert.equal(
    workspace.cards.some((card) => card.meta.id === character.id),
    false,
  );
  assert.deepEqual(
    workspace.inactive.find((entry) => entry.id === character.id),
    { id: character.id, kind: 'character', code: 'override-off' },
  );
});

test('挂载解析：world_pack_ids（旧字段）与 mounts.pack_ids 等价；都不填 = 全库', () => {
  const packs = new Map([['p1', ['a', 'b'] as const]]);
  assert.equal(mountedIdsOf({ characters: [], premise: '', opening_mode: 'self', origin: 'card' }, packs), undefined);
  assert.deepEqual(
    [...(mountedIdsOf({ characters: [], premise: '', opening_mode: 'self', origin: 'card', world_pack_ids: ['p1'] }, packs) ?? [])].sort(),
    ['a', 'b'],
  );
  assert.deepEqual(
    [...(mountedIdsOf({ characters: [], premise: '', opening_mode: 'self', origin: 'card', mounts: { pack_ids: ['p1'], card_ids: ['c'] } }, packs) ?? [])].sort(),
    ['a', 'b', 'c'],
  );
});
