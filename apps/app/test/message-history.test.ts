import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepository } from '../src/data/memory-repository.ts';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import type { Repository } from '../src/data/repository.ts';
import { createAppStore } from '../src/app/state.ts';
import type { SessionSetup } from '../../../packages/cards/src/index.ts';

/**
 * B15/B16/B17：消息编辑（新版本）、版本切换、会话分叉。
 * 两个仓储实现都要给出同样的语义；op 仓储另外验证 setup/消息复制与 forkedFrom。
 */

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

async function sessionWithMessage(repo: Repository): Promise<{ sessionId: string; messageId: string }> {
  const character = await repo.characters.save({ name: '星野' });
  const session = await repo.sessions.create(character.id, '测试');
  const message = await repo.messages.append(session.id, 'assistant', '第一版正文', 'done', 1_700_000_000_000);
  return { sessionId: session.id, messageId: message.id };
}

test('B15：编辑 → 新版本 active；旧正文保留；列表只带摘要（不带全量内容）', async () => {
  for (const [label, repo] of await repositories()) {
    const { messageId } = await sessionWithMessage(repo);
    assert.equal(await repo.messages.edit(messageId, '第二版正文'), true);

    const [listed] = await repo.messages.list((await repo.sessions.list())[0]?.id ?? '');
    assert.equal(listed?.content, '第二版正文', `${label}：active 内容跟着新版本`);
    assert.equal(listed?.revisionCount, 2, `${label}：版本数`);
    assert.ok((listed?.activeRevisionId ?? '').length > 0);
    const revisions = await repo.messages.revisions(messageId);
    assert.equal(revisions.length, 2, `${label}：两版都在`);
    assert.deepEqual(revisions.map((revision) => revision.content), ['第一版正文', '第二版正文']);
    assert.deepEqual(revisions.map((revision) => revision.active), [false, true]);
  }
});

test('B16：切回旧版本 → 正文回退且旧版仍保留；错误路径可见（DataError/false）', async () => {
  for (const [label, repo] of await repositories()) {
    const { messageId } = await sessionWithMessage(repo);
    await repo.messages.edit(messageId, '第二版正文');
    const revisions = await repo.messages.revisions(messageId);
    const first = revisions[0];
    assert.ok(first !== undefined);

    assert.equal(await repo.messages.selectRevision(messageId, first.id), true);
    const listed = (await repo.messages.list((await repo.sessions.list())[0]?.id ?? ''))[0];
    assert.equal(listed?.content, '第一版正文', `${label}：切回旧版`);
    assert.equal(listed?.activeRevisionId, first.id);

    assert.equal(await repo.messages.selectRevision(messageId, '不存在'), false, `${label}：未知版本返回 false`);
    assert.deepEqual(await repo.messages.forks(messageId), [], `${label}：线性编辑不产生分叉组`);
    assert.equal(await repo.messages.edit('不存在', 'x'), false, `${label}：未知消息返回 false`);
    await assert.rejects(() => repo.messages.edit(messageId, '   '), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid-argument', `${label}：空正文要明确报错`);
      return true;
    });
  }
});

const SETUP: SessionSetup = {
  characters: [],
  premise: '雨夜的边境酒馆',
  opening_mode: 'self',
  origin: 'user',
};

test('B17：分叉复制 setup + 全部消息（role/content/createdAt/status/meta），原会话不变', async () => {
  const ports = createLocalOpPorts();
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;
  const character = await repo.characters.save({ name: '星野' });
  assert.ok(repo.sessions.createWithSetup !== undefined);
  assert.ok(repo.setups !== undefined);
  const original = await repo.sessions.createWithSetup({
    characterIds: [character.id],
    setup: { ...SETUP, characters: [character.id] },
    title: '隘口之夜',
  });
  const meta = { modelId: 'deepseek-chat', reasoning: '先想', tokens: { prompt: 1, completion: 2, estimated: true } };
  await repo.messages.append(original.id, 'user', '你好', 'done', 1_700_000_000_000);
  await repo.messages.append(original.id, 'assistant', '写了一半', 'stopped', 1_700_000_001_000, meta);
  const edited = (await repo.messages.list(original.id))[1];
  assert.ok(edited !== undefined);
  await repo.messages.edit(edited.id, '改过的正文');

  const forked = await repo.sessions.list(); // 触发按时间排序，确认列表用得上
  assert.ok(forked.length >= 1);
  const { forkSessionInRepository } = await import('../src/data/session-fork.ts');
  const child = await forkSessionInRepository(repo, original.id);
  assert.equal(child.forkedFrom, original.id, 'forkedFrom 指向原会话');
  assert.equal(child.title, '隘口之夜（分叉）');
  assert.equal(child.messageCount, 2, '消息数一致');

  const originalMessages = await repo.messages.list(original.id);
  const childMessages = await repo.messages.list(child.id);
  assert.deepEqual(
    childMessages.map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      status: message.status,
      meta: message.meta,
    })),
    originalMessages.map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      status: message.status,
      meta: message.meta,
    })),
    '消息逐条一致（含 stopped 与 meta）',
  );
  assert.deepEqual(await repo.setups.get(child.id), await repo.setups.get(original.id), 'setup 一致');

  // 原会话完全不变
  assert.equal(originalMessages.length, 2);
  assert.equal(originalMessages[1]?.content, '改过的正文');
  const after = await repo.sessions.list();
  assert.equal(after.filter((session) => session.id === child.id).length, 1, '新会话在列表里');

  await assert.rejects(() => forkSessionInRepository(repo, '不存在'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'not-found');
    return true;
  });
});

test('state actions：editMessage/selectMessageRevision/forkSession 刷新状态并返回结果', async () => {
  const ports = createLocalOpPorts();
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;
  const store = createAppStore(repo);
  const character = await repo.characters.save({ name: '星野' });
  const session = await repo.sessions.create(character.id, '测试');
  const message = await repo.messages.append(session.id, 'assistant', '旧正文');
  await store.actions.loadMessages(session.id);

  assert.equal(await store.actions.editMessage(message.id, '新正文'), true);
  assert.equal(store.getState().messages[0]?.content, '新正文');
  const revisions = await store.actions.messageRevisions(message.id);
  const old = revisions[0];
  assert.ok(old !== undefined);
  assert.equal(await store.actions.selectMessageRevision(message.id, old.id), true);
  assert.equal(store.getState().messages[0]?.content, '旧正文');

  const child = await store.actions.forkSession(session.id);
  assert.equal(child.forkedFrom, session.id);
  assert.ok(store.getState().sessions.some((item) => item.id === child.id));
});
