import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createMemoryRepository } from '../src/data/memory-repository.ts';
import { DataError, type Repository } from '../src/data/repository.ts';

/**
 * 长期记忆的契约测试：**两个实现都跑**。
 *
 * 记忆是内容，与角色/世界书一样必须能在两种实现下给出同样的行为；
 * `op-log` 那一份还额外证明了"重启后按日志重放仍在"。
 */
test('契约：长期记忆能保存、按角色筛选、删除，并且能重启后仍在（两个实现都跑）', async () => {
  const contexts: Array<{ label: string; repo: Repository; reopen: () => Promise<Repository> }> = [];

  const memory = createMemoryRepository();
  contexts.push({ label: '内存', repo: memory, reopen: async () => memory });

  const ports = createLocalOpPorts(createMemoryKeyValue());
  const logged = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await logged.ready;
  contexts.push({
    label: 'op-log',
    repo: logged,
    reopen: async () => {
      const revived = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
      await revived.ready;
      return revived;
    },
  });

  for (const { label, repo, reopen } of contexts) {
    const character = await repo.characters.save({ name: '星野' });
    const bound = await repo.memories.save({
      characterId: character.id,
      text: '星野怕水。',
      keys: ['水', ' 水 '],
      importance: 80,
      createdBy: 'agent',
    });
    assert.deepEqual(bound.keys, ['水'], `${label}：关键词去重`);
    assert.equal(bound.createdBy, 'agent', `${label}：是谁写的要留下来`);
    assert.equal(bound.characterId, character.id);

    const global = await repo.memories.save({ text: '用户不要死亡结局。', keys: [], importance: 999 });
    assert.equal(global.characterId, '', `${label}：不写角色 = 全局`);
    assert.equal(global.importance, 100, `${label}：重要度收敛到 0-100`);

    assert.deepEqual(
      (await repo.memories.forCharacter(character.id)).map((item) => item.text).sort(),
      ['星野怕水。', '用户不要死亡结局。'].sort(),
      `${label}：按角色筛出绑定的 + 全局的`,
    );
    assert.deepEqual((await repo.memories.forCharacter(undefined)).map((item) => item.text), ['用户不要死亡结局。']);

    await assert.rejects(
      () => repo.memories.save({ text: '   ' }),
      (error: unknown) => (error as DataError).code === 'invalid-argument',
      `${label}：空内容要报 invalid-argument`,
    );

    const revived = await reopen();
    assert.equal((await revived.memories.list()).length, 2, `${label}：重开后记忆还在`);
    assert.equal(await repo.memories.remove(bound.id), true);
    assert.equal(await repo.memories.remove(bound.id), false, `${label}：重复删除返回 false`);
  }
});
