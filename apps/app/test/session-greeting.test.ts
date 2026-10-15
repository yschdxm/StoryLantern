import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createMemoryRepository } from '../src/data/memory-repository.ts';
import type { Repository } from '../src/data/repository.ts';

/**
 * ⑦ 的开场白选择 + 角色字段往返（内存与 op-log 两个实现都跑）。
 *
 * 这几条是**事故驱动**的：做"建会话时选开场白"时发现，op 日志这条路上
 * `characterUpsert` 只写了 6 个字段、漏了 `systemPrompt` 与 `alternateGreetings`，
 * 而物化是"整体覆盖"——于是界面里能编辑、能"保存成功"，读回来永远是空。
 *
 * 原来只有投影层的测试（`packages/oplog/test/character-fields.test.ts`）：
 * 投影**支持**这两个字段、仓储却**不传**，缺口正好落在两者之间，谁都不报错。
 * 所以这里在**仓储层**再钉一遍：这条测试在修复前必然红。
 */

function greetingContract(name: string, make: () => Promise<Repository>): void {
  test(name + '：角色的 systemPrompt / alternateGreetings 必须存得住', async () => {
    const repo = await make();
    const created = await repo.characters.save({
      name: '夜巡',
      systemPrompt: '你只回答一句话。',
      alternateGreetings: ['第二条开场白', ' 第三条 '],
    });

    const readBack = await repo.characters.get(created.id);
    assert.equal(readBack?.systemPrompt, '你只回答一句话。', '系统提示必须真的写进去');
    assert.deepEqual(readBack?.alternateGreetings, ['第二条开场白', '第三条'], '备选开场白要存住且两端空白裁掉');

    // 显式清空也要生效（整体覆盖语义 + 空值被投影省略）
    await repo.characters.save({ id: created.id, name: '夜巡', systemPrompt: '', alternateGreetings: [] });
    const cleared = await repo.characters.get(created.id);
    assert.equal(cleared?.systemPrompt ?? '', '');
    assert.deepEqual(cleared?.alternateGreetings ?? [], []);
  });

  test(name + '：建会话时可以选开场白（0=第一条、1=备选、-1=不插入、越界退回第一条）', async () => {
    const repo = await make();
    const character = await repo.characters.save({
      name: '双开场',
      firstMessage: '第一条',
      alternateGreetings: ['第二条'],
    });
    const contents = async (sessionId: string): Promise<string[]> =>
      (await repo.messages.list(sessionId)).map((message) => message.content);

    const first = await repo.sessions.create(character.id);
    assert.deepEqual(await contents(first.id), ['第一条'], '不传下标 = 旧行为（第一条）');

    const second = await repo.sessions.create(character.id, undefined, 1);
    assert.deepEqual(await contents(second.id), ['第二条'], '下标 1 = 第一条备选');

    const none = await repo.sessions.create(character.id, undefined, -1);
    assert.deepEqual(await contents(none.id), [], '不插入开场白应是干净会话');

    const fallback = await repo.sessions.create(character.id, undefined, 9);
    assert.deepEqual(await contents(fallback.id), ['第一条'], '越界退回第一条，不报错');
  });
}

greetingContract('内存仓储（语义参考）', async () => createMemoryRepository());
greetingContract('op-log 仓储（日志是唯一事实源）', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  return createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
});

test('op-log：角色字段进的是 op 日志——重建后仍在（当初漏字段事故的回归保护）', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const first = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await first.ready;
  const saved = await first.characters.save({
    name: '夜巡',
    systemPrompt: '只回答一句话',
    alternateGreetings: ['备选一'],
  });

  // 从同一份日志重建（等价于重启、或换设备重放日志）
  const rebuilt = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await rebuilt.ready;
  const back = await rebuilt.characters.get(saved.id);
  assert.equal(back?.systemPrompt, '只回答一句话');
  assert.deepEqual(back?.alternateGreetings, ['备选一']);
});
