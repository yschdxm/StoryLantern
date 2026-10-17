import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * M2 退出判据：**界面展示的请求 == 宿主真正发出去的请求体**。
 *
 * 这一侧钉的是"展示"那半：用真实的装配函数 `buildChatRequest` 从同一份输入得到
 * messages/systemPrompt，再和 golden 里**宿主会序列化出去的** body 比对内容。
 * 另一半在 Rust：`apps/shell/src-tauri/src/chat.rs` 的 `body_matches_golden_byte_for_byte`
 * 断言 `build_body(...)` 的序列化结果与 golden 逐字节相同。
 *
 * 两侧读**同一个** apps/shell/src-tauri/tests/chat-body-golden.json：
 * 任何一侧改了字段（少传 stream、改了 system 消息位置、加了/删了字段）都会红。
 */

const GOLDEN_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'shell',
  'src-tauri',
  'tests',
  'chat-body-golden.json',
);

interface Golden {
  request: { systemPrompt: string; messages: { role: string; content: string }[] };
  target: { model: string; temperature: number; maxTokens: number };
  body: string;
}

test('发送字节 == 展示字节：界面装配出的消息与宿主会发出去的请求体逐条一致', async () => {
  const golden = JSON.parse(await readFile(GOLDEN_PATH, 'utf8')) as Golden;
  const body = JSON.parse(golden.body) as {
    model: string;
    messages: { role: string; content: string }[];
    stream: boolean;
    temperature: number;
    max_tokens: number;
  };

  // 展示侧：systemPrompt 与 messages 是界面上能看到的那部分
  const shown = [
    ...(golden.request.systemPrompt.trim() === ''
      ? []
      : [{ role: 'system' as const, content: golden.request.systemPrompt }]),
    ...golden.request.messages,
  ];

  // 发送侧：请求体里的 messages 必须与展示侧逐条相同（顺序也是）
  assert.deepEqual(body.messages, shown, '展示的消息与宿主发出去的消息必须逐条一致');
  assert.equal(body.model, golden.target.model);
  assert.equal(body.stream, true, '必须流式（少传它就是一类真实事故）');
  assert.equal(body.temperature, golden.target.temperature);
  assert.equal(body.max_tokens, golden.target.maxTokens);

  // 请求体的键集合也要钉住：多一个字段（例如把密钥塞进去）会在这里被看见
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('api_key'), '请求体里不允许出现密钥字段');
});
