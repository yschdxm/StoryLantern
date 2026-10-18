import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../src/data/memory-repository.ts';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import type { Repository } from '../src/data/repository.ts';
import type { MessageMeta, MessageStatus } from '../src/data/types.ts';

/**
 * 消息生成元数据（模型/思考链/引用/token/耗时）与 `stopped` 状态：
 * **两个实现都要能存、能读回**，且旧消息（没有 meta）的读法不变。
 */

const META: MessageMeta = {
  modelId: 'deepseek-chat',
  modelLabel: 'DeepSeek Chat',
  reasoning: '先想清楚，再落笔。',
  citations: [
    { index: 1, messageId: 'M1', resolved: true },
    { index: 3, resolved: false },
  ],
  tokens: { prompt: 200, completion: 50, estimated: true },
  timing: { firstDeltaMs: 80, totalMs: 1500 },
};

async function repositories(): Promise<readonly [string, Repository][]> {
  const memory = createMemoryRepository();
  const ports = createLocalOpPorts();
  const logged = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await logged.ready;
  return [
    ['内存', memory as Repository],
    ['op-log', logged as Repository],
  ];
}

test('append(meta, stopped)：两个实现都原样读回 meta，状态是 stopped', async () => {
  for (const [label, repo] of await repositories()) {
    const character = await repo.characters.save({ name: '星野' });
    const session = await repo.sessions.create(character.id, '测试');
    const status: MessageStatus = 'stopped';
    const message = await repo.messages.append(session.id, 'assistant', '写到一半被停下的回复', status, undefined, META);
    assert.deepEqual(message.meta, META, `${label}：append 返回值带 meta`);
    assert.equal(message.status, 'stopped', `${label}：状态是 stopped`);

    const listed = (await repo.messages.list(session.id))[0];
    assert.deepEqual(listed?.meta, META, `${label}：list 读回 meta`);
    assert.equal(listed?.status, 'stopped', `${label}：list 读回 stopped`);
  }
});

test('旧消息没有 meta 时读回仍是 undefined（不能凭空造字段）', async () => {
  for (const [label, repo] of await repositories()) {
    const character = await repo.characters.save({ name: '星野' });
    const session = await repo.sessions.create(character.id, '测试');
    const message = await repo.messages.append(session.id, 'user', '普通消息');
    assert.equal(message.meta, undefined, `${label}：没传 meta 就不该有`);
    assert.equal(message.status, 'done');
  }
});

test('appendMany 也能带 meta 与 stopped（导入历史/整段落库走这条）', async () => {
  for (const [label, repo] of await repositories()) {
    const character = await repo.characters.save({ name: '星野' });
    const session = await repo.sessions.create(character.id, '测试');
    const added = await repo.messages.appendMany(session.id, [
      { role: 'assistant', content: '一条带元数据的历史回复', status: 'stopped', meta: META },
      { role: 'user', content: '普通历史' },
    ]);
    assert.equal(added, 2, `${label}：两条都写入`);
    const listed = await repo.messages.list(session.id);
    const withMeta = listed.find((item) => item.content === '一条带元数据的历史回复');
    assert.deepEqual(withMeta?.meta, META, `${label}：批量写入带 meta`);
    assert.equal(withMeta?.status, 'stopped', `${label}：批量写入保留 stopped`);
    const plain = listed.find((item) => item.content === '普通历史');
    assert.equal(plain?.meta, undefined);
  }
});
