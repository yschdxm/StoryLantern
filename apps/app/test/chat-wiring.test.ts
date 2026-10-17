import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../src/app/state.ts';
import { loadWorkspace } from '../src/app/workspace.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { buildChatOptionsV2 } from '../src/screens/chat-request.ts';
import { buildChatRequestV2 } from '../src/data/prompt-v2.ts';

/**
 * 端到端装配链（不渲染 React）：
 *   仓储写入（旧角色 op）→ 会话开局配置 → 工作区兜底投影 → 新装配器 → systemPrompt。
 *
 * 这条链是"数据层改造真的接上了"的唯一证据：单测各自绿，不代表它们串起来能跑。
 * 同时也钉住过渡期语义：**旧角色卡（6 个文本字段）仍必须能装配出可用的提示词**。
 */

test('装配链：旧角色 + 新装配器，systemPrompt 里有角色、开局处境与角色补充', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;

  const character = await repo.characters.save({
    name: '星野',
    description: '夜巡的剑士',
    personality: '克制、谨慎',
    scenario: '雨夜的边境酒馆',
    firstMessage: '「进来吧。」',
    systemPrompt: '始终保持短句。',
  });
  const session = await repo.sessions.create(character.id);

  const state: AppState = {
    status: 'ready',
    characters: await repo.characters.list(),
    sessions: await repo.sessions.list(),
    messages: await repo.messages.list(session.id),
    lorebooks: [],
    memories: [],
    facts: [],
    settings: { 'chat.history_limit': '40' },
  };
  const workspace = await loadWorkspace(repo, state, session.id);
  assert.equal(workspace.setup?.characters[0], character.id, '建会话时要落下开局配置');
  assert.equal(workspace.setup?.premise, '雨夜的边境酒馆', '旧 scenario 迁移成这一局处境');

  const request = buildChatRequestV2(buildChatOptionsV2({ state, sessionId: session.id, workspace }));

  assert.ok(request.systemPrompt.includes('你要扮演「星野」'), '角色身份进系统提示');
  assert.ok(request.systemPrompt.includes('雨夜的边境酒馆'), '开局处境进系统提示');
  assert.ok(request.systemPrompt.includes('始终保持短句'), '角色自带提示进系统提示');
  assert.ok(
    request.messages.some((message) => message.content.includes('进来吧')),
    '开场白是真实历史消息（不是拼进系统提示）',
  );
  assert.equal(request.trace.pipeline, false, '测试里没给组装管线：走兜底路径，且面板要如实说明');
  assert.ok(request.trace.blocks.length > 0);
});

test('装配链：会话工作区把旧世界书投影成典籍卡并把关键词命中的内容放进提示词', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;

  const character = await repo.characters.save({ name: '星野' });
  const book = await repo.lorebooks.save({ name: '边境常识' });
  await repo.lorebooks.saveEntry({ lorebookId: book.id, keys: ['铜铃'], content: '铜铃是隘口的报信之物' });
  const session = await repo.sessions.create(character.id);
  await repo.messages.append(session.id, 'user', '铜铃响了');

  const state: AppState = {
    status: 'ready',
    characters: await repo.characters.list(),
    sessions: await repo.sessions.list(),
    messages: await repo.messages.list(session.id),
    lorebooks: await repo.lorebooks.list(),
    memories: [],
    facts: [],
    settings: {},
  };
  const workspace = await loadWorkspace(repo, state, session.id);
  const request = buildChatRequestV2(buildChatOptionsV2({ state, sessionId: session.id, workspace }));

  assert.ok(request.lore.length > 0, '命中关键词的典籍要出现在本次请求里');
  assert.ok(request.systemPrompt.includes('铜铃是隘口的报信之物'), '命中内容进系统提示');
  assert.ok(request.systemPrompt.includes('相关设定'), '保持旧的可读标题（提示词语言是中文）');
});
