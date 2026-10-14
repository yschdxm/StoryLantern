import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest, characterPrompt } from '../src/data/prompt.ts';
import { SETTING_KEYS } from '../src/data/types.ts';

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
  assert.deepEqual(
    request.messages,
    [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '第二句' },
      { role: 'system', content: '旁白' },
    ],
  );
});

test('prompt：没有角色也能对话（纯文本模式），系统提示可以为空', () => {
  const request = buildChatRequest({ settings: {}, history: [{ role: 'user', content: '你好' }] });
  assert.equal(request.systemPrompt, '');
  assert.deepEqual(request.messages, [{ role: 'user', content: '你好' }]);
});
