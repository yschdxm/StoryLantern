import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, characterPrompt, estimateTokens, type PromptCharacter } from '../src/data/prompt.ts';
import { registerPromptBlocks } from '../src/data/prompt-blocks.ts';
import { assembleBlocks, estimateTokens as pipelineEstimateTokens } from '../../../plugins/writing-pipeline/src/index.ts';
import { Registry } from '../../../packages/plugin-api/src/index.ts';
import type { BlockDefinition } from '../../../plugins/context-blocks/src/index.ts';
import { SETTING_KEYS, type Lorebook } from '../src/data/types.ts';

/**
 * 上下文组装：M1 之后宿主不再组装 prompt，所以这里的规则就是"模型看到什么"的唯一实现。
 * 因此要测的是**取舍**：哪些内容进上下文、哪些被排除、以及排除的理由能不能说清楚。
 */

test('prompt：角色卡字段进系统提示，空字段不写空标题', () => {
  const prompt = characterPrompt({
    name: '星野',
    description: '夜巡的守望者',
    personality: '',
    scenario: '',
    exampleDialogue: '{{user}}: 在吗',
  });
  assert.match(prompt, /你要扮演「星野」/);
  assert.match(prompt, /【设定】夜巡的守望者/);
  assert.match(prompt, /【对话示例】/);
  assert.ok(!prompt.includes('【性格】'), '空字段不该留标题');
  assert.ok(!prompt.includes('【场景】'));
  assert.match(prompt, /直接以角色身份说话/);

  assert.equal(characterPrompt(undefined), '', '没有角色时不该编出一段设定');
});

test('prompt：自定义 system prompt 排在最前，与角色设定拼在一起', () => {
  const request = buildChatRequest({
    settings: { [SETTING_KEYS.systemPrompt]: '始终保持短句。' },
    character: { name: '星野', description: '', personality: '', scenario: '', exampleDialogue: '' },
    history: [{ role: 'user', content: '在吗' }],
  });
  assert.ok(request.systemPrompt.startsWith('始终保持短句。'));
  assert.match(request.systemPrompt, /你要扮演「星野」/);
});

test('prompt：空消息与失败消息不进上下文（否则模型会跟着复读错误信息）', () => {
  const request = buildChatRequest({
    settings: {},
    history: [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '   ', status: 'streaming' },
      { role: 'assistant', content: '请求失败：连不上', status: 'error' },
      { role: 'assistant', content: '第二句', status: 'done' },
      { role: 'system', content: '旁白' },
    ],
  });
  assert.deepEqual(request.messages, [
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '第二句' },
    { role: 'system', content: '旁白' },
  ]);
});

test('prompt：没有角色也能对话（纯文本模式），系统提示可以为空', () => {
  const request = buildChatRequest({ settings: {}, history: [{ role: 'user', content: '你好' }] });
  assert.equal(request.systemPrompt, '');
  assert.deepEqual(request.messages, [{ role: 'user', content: '你好' }]);
});

// ---------------------------------------------------------------- 世界书注入

const lorebook = (
  entries: { id: string; keys: string[]; content: string; order?: number; constant?: boolean }[],
): Lorebook => ({
  id: 'B1',
  name: '星野的世界',
  description: '',
  characterIds: [],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  entries: entries.map((entry) => ({
    id: entry.id,
    keys: entry.keys,
    secondaryKeys: [],
    content: entry.content,
    comment: '',
    enabled: true,
    order: entry.order ?? 100,
    caseSensitive: false,
    recursive: true,
    depth: 0,
    constant: entry.constant ?? false,
    createdAt: 1,
    updatedAt: 1,
  })),
});

test('prompt：命中关键词的世界书条目进系统提示，并如实回报注入了什么', () => {
  const request = buildChatRequest({
    settings: {},
    history: [{ role: 'user', content: '我在隘口听见了铜铃' }],
    lorebooks: [
      lorebook([
        { id: 'e1', keys: ['铜铃'], content: '铜铃是隘口的报信之物。' },
        { id: 'e2', keys: ['雪'], content: '雪线以上没有活物。' },
      ]),
    ],
  });

  assert.match(request.systemPrompt, /【相关设定】/);
  assert.match(request.systemPrompt, /铜铃是隘口的报信之物。/);
  assert.ok(!request.systemPrompt.includes('雪线以上没有活物。'), '没命中的设定不该塞进去');
  assert.deepEqual(request.lore.map((entry) => entry.entryId), ['e1'], '界面要能告诉用户注入了哪几条');
  assert.deepEqual(request.lore[0]?.matchedKeys, ['铜铃']);
});

test('prompt：没有命中时不写【相关设定】标题（不给模型塞空段）', () => {
  const request = buildChatRequest({
    settings: {},
    character: { name: '星野', description: '', personality: '', scenario: '', exampleDialogue: '' },
    history: [{ role: 'user', content: '随便聊聊' }],
    lorebooks: [lorebook([{ id: 'e1', keys: ['铜铃'], content: '铜铃的设定。' }])],
  });
  assert.ok(!request.systemPrompt.includes('【相关设定】'));
  assert.deepEqual(request.lore, []);
});

test('prompt：常量条目每次都注入（不问关键词）', () => {
  const request = buildChatRequest({
    settings: {},
    history: [{ role: 'user', content: '早上好' }],
    lorebooks: [lorebook([{ id: 'e1', keys: [], content: '这个世界有两轮月亮。', constant: true }])],
  });
  assert.match(request.systemPrompt, /两轮月亮/);
  assert.equal(request.lore[0]?.reason, 'constant');
});

test('prompt：失败消息不参与世界书匹配（错误文本不该触发设定）', () => {
  const request = buildChatRequest({
    settings: {},
    history: [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '请求失败：铜铃连不上', status: 'error' },
    ],
    lorebooks: [lorebook([{ id: 'e1', keys: ['铜铃'], content: '铜铃的设定。' }])],
  });
  assert.deepEqual(request.lore, [], '错误信息里的关键词不该触发注入');
});

// ---------------------------------------------------------------- 历史条数上限与可解释性

test('prompt：历史上限生效，被裁掉的消息带原因进 trace（不是悄悄丢掉）', () => {
  const history = Array.from({ length: 6 }, (_, index) => ({ role: 'user' as const, content: `第 ${index + 1} 句` }));
  const request = buildChatRequest({ settings: { [SETTING_KEYS.historyLimit]: '3' }, history });

  assert.deepEqual(request.messages.map((message) => message.content), ['第 4 句', '第 5 句', '第 6 句']);
  assert.equal(request.trace.historyIncluded, 3);
  assert.equal(request.trace.historyLimit, 3);
  assert.deepEqual(
    request.trace.excluded.map((item) => item.reason),
    ['limit', 'limit', 'limit'],
  );
  assert.deepEqual(
    request.trace.excluded.map((item) => item.preview),
    ['第 1 句', '第 2 句', '第 3 句'],
  );
});

test('prompt：trace 说明系统提示由哪些块构成、各占多少', () => {
  const request = buildChatRequest({
    settings: { [SETTING_KEYS.systemPrompt]: '短句。' },
    character: { name: '星野', description: '守望者', personality: '', scenario: '', exampleDialogue: '' },
    history: [{ role: 'user', content: '在吗' }],
  });

  assert.equal(request.trace.pipeline, false, '测试里没注入管线，应当如实标记');
  assert.deepEqual(
    request.trace.blocks.map((block) => block.kind),
    ['custom', 'character'],
  );
  for (const block of request.trace.blocks) {
    assert.ok(block.chars > 0);
    assert.ok(block.estimatedTokens > 0);
    assert.equal(block.included, true);
  }
  assert.equal(request.trace.systemChars, request.systemPrompt.length);
  assert.equal(request.trace.messageChars, '在吗'.length);
});

test('prompt：token 估算与管线里的实现必须一致（两份实现漂移会让面板上的数字骗人）', () => {
  for (const sample of ['', 'hello world', '短句。', '这是一段中文和 English 混排的文本。', 'a'.repeat(100)]) {
    assert.equal(estimateTokens(sample), pipelineEstimateTokens(sample), sample);
  }
});

// ---------------------------------------------------------------- 走管线（真正的组装路径）

/** 用真实的 Registry + 插件的 assembleBlocks 搭一条最小管线（不启内核也能测）。 */
function pipeline(blocks: BlockDefinition[], budgetTokens: number) {
  return (context: Parameters<typeof assembleBlocks>[1], budget = budgetTokens) =>
    assembleBlocks(blocks, context, budget);
}

test('prompt：走管线时块按预算裁剪，trace 里带上裁掉的理由', () => {
  const registry = new Registry<BlockDefinition>({ onDuplicate: 'replace' });
  registerPromptBlocks(registry);
  const blocks = registry.list().map((entry) => entry.value);

  const character: PromptCharacter = {
    name: '星野',
    description: '夜巡的守望者',
    personality: '',
    scenario: '',
    exampleDialogue: '',
  };
  const request = buildChatRequest({
    settings: { [SETTING_KEYS.systemPrompt]: '始终保持短句。' },
    character,
    history: [{ role: 'user', content: '在吗' }],
    assemble: pipeline(blocks, 4000),
    budgetTokens: 4000,
  });

  assert.equal(request.trace.pipeline, true);
  assert.match(request.systemPrompt, /始终保持短句。/);
  assert.match(request.systemPrompt, /你要扮演「星野」/);
  assert.equal(request.trace.blocks.length, 2);
  assert.equal(request.trace.blocks.every((block) => block.included), true);
  assert.ok(request.trace.blocks.every((block) => block.reason !== ''), '管线必须给出纳入/裁掉的理由');
  assert.equal(request.trace.budgetTokens, 4000);

  // 预算压到极小：高优先级块进、低的被裁，且理由说明是超预算
  const tight = buildChatRequest({
    settings: { [SETTING_KEYS.systemPrompt]: '始终保持短句。' },
    character,
    history: [{ role: 'user', content: '在吗' }],
    assemble: pipeline(blocks, 40),
    budgetTokens: 40,
  });
  assert.equal(tight.trace.omitted > 0, true, '预算不足时应当有块被裁');
  assert.equal(tight.systemPrompt.includes('直接以角色身份说话'), false, '被裁的块不该出现在系统提示里');
});

test('prompt：走管线时世界书命中仍然被记录下来（块渲染时写回）', () => {
  const registry = new Registry<BlockDefinition>({ onDuplicate: 'replace' });
  registerPromptBlocks(registry);
  const blocks = registry.list().map((entry) => entry.value);

  const request = buildChatRequest({
    settings: {},
    history: [{ role: 'user', content: '听见铜铃' }],
    lorebooks: [lorebook([{ id: 'e1', keys: ['铜铃'], content: '铜铃是报信之物。' }])],
    assemble: pipeline(blocks, 4000),
    budgetTokens: 4000,
  });

  assert.match(request.systemPrompt, /【相关设定】/);
  assert.deepEqual(request.lore.map((entry) => entry.entryId), ['e1']);
  const loreBlock = request.trace.blocks.find((block) => block.kind === 'lore');
  assert.ok(loreBlock !== undefined);
  assert.equal(loreBlock.included, true);
});

test('prompt：角色自带的系统提示优先于全局提示（导入卡片后不该被全局模板盖掉）', () => {
  const character: PromptCharacter = {
    name: '星野',
    description: '',
    personality: '',
    scenario: '',
    exampleDialogue: '',
    systemPrompt: '你只写短句，不加解释。',
  };
  const withBoth = buildChatRequest({
    settings: { [SETTING_KEYS.systemPrompt]: '全局模板：始终礼貌。' },
    character,
    history: [{ role: 'user', content: '在吗' }],
  });
  assert.ok(withBoth.systemPrompt.startsWith('你只写短句，不加解释。'), '角色自己的提示要排在前面');
  assert.ok(!withBoth.systemPrompt.includes('全局模板'), '两者都有时用角色的');

  const onlyGlobal = buildChatRequest({
    settings: { [SETTING_KEYS.systemPrompt]: '全局模板：始终礼貌。' },
    character: { name: '星野', description: '', personality: '', scenario: '', exampleDialogue: '' },
    history: [{ role: 'user', content: '在吗' }],
  });
  assert.ok(onlyGlobal.systemPrompt.startsWith('全局模板'), '角色没写就退回全局');
});
