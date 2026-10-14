import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, characterPrompt } from '../src/data/prompt.ts';
import { SETTING_KEYS, type Lorebook } from '../src/data/types.ts';

/**
 * 上下文组装：M1 之后宿主不再组装 prompt，所以这里的规则就是"模型看到什么"的唯一实现。
 * 因此要测的是**取舍**：哪些内容进上下文、哪些被排除。
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
