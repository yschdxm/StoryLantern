import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../src/data/memory-repository.ts';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import type { Repository } from '../src/data/repository.ts';

/**
 * 候选回复（SillyTavern 的 swipes）：**两个实现都要有同样的语义**。
 * 关键三条：正文不动（只有选中候选才改显示）、重复与空串被忽略（可安全重放）、选中后正文跟着换。
 */
test('候选：追加不动正文、忽略重复与空串；选中后正文跟着换（两个实现都跑）', async () => {
  const memory = createMemoryRepository();
  const ports = createLocalOpPorts();
  const logged = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await logged.ready;

  for (const [label, repo] of [
    ['内存', memory as Repository],
    ['op-log', logged as Repository],
  ] as const) {
    const character = await repo.characters.save({ name: '星野' });
    const session = await repo.sessions.create(character.id, '测试');
    const message = await repo.messages.append(session.id, 'assistant', '第一条回复');
    assert.deepEqual(message.candidates, [], `${label}：新消息没有候选`);

    const added = await repo.messages.appendCandidates(message.id, ['第二条回复', '第一条回复', '  ', '第二条回复', '第三条']);
    assert.equal(added, 2, `${label}：与正文相同、空串、重复都不计`);
    const after = (await repo.messages.list(session.id))[0];
    assert.equal(after?.content, '第一条回复', `${label}：追加候选不动正文`);
    assert.deepEqual(after?.candidates.map((item) => item.content), ['第二条回复', '第三条']);

    const second = after?.candidates[0];
    assert.ok(second !== undefined);
    assert.equal(await repo.messages.selectCandidate(message.id, second.id), true);
    const selected = (await repo.messages.list(session.id))[0];
    assert.equal(selected?.content, '第二条回复', `${label}：选中后正文换成候选内容`);
    assert.equal(selected?.selectedCandidateId, second.id);
    assert.equal(await repo.messages.selectCandidate(message.id, '不存在'), false, `${label}：选不存在的候选返回 false`);
  }
});
