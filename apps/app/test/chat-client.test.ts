import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WireError, type WireInvokeRequest, type WireTransport } from '../../../packages/wire/src/index.ts';
import { createChatClient, type ChatCall } from '../src/data/chat-client.ts';

/** 极简传输：把预设的 chunk 依次吐出；`chat.preview` 返回固定对象。 */
function transportOf(handler: (request: WireInvokeRequest) => unknown[]): WireTransport {
  return {
    kind: 'test',
    async *invoke(request) {
      for (const chunk of handler(request)) yield chunk;
    },
  };
}

const CALL: ChatCall = {
  messages: [{ role: 'user', content: '甲' }],
  systemPrompt: '开头',
  postHistory: '本次回复请保持克制。',
  profileId: 'p1',
};

test('流式：先正文、再思考链、再正文；onDelta 两类都透传，结果同时有 text 与 reasoning', async () => {
  const seen: string[] = [];
  const client = createChatClient(
    transportOf(() => [
      { delta: '你' },
      { reasoning: '先想' },
      { delta: '好' },
      { reasoning: '一下' },
    ]),
  );
  const result = await client.reply(CALL, {
    onDelta: (chunk) => seen.push(`${chunk.delta ?? ''}|${chunk.reasoning ?? ''}`),
  });
  assert.equal(result.text, '你好');
  assert.equal(result.reasoning, '先想一下');
  assert.equal(result.aborted, false);
  assert.deepEqual(seen, ['你|', '|先想', '好|', '|一下'], 'onDelta 按到达顺序透传，不合并、不改写');
});

test('流式：aborted 时返回已经收到的正文与思考链（不能丢半截）', async () => {
  const client = createChatClient({
    kind: 'test',
    async *invoke() {
      yield { delta: '已经收到的正文' };
      yield { reasoning: '已经收到的思考' };
      throw new WireError('aborted', '已停止', { service: 'chat', method: 'reply' });
    },
  });
  const result = await client.reply(CALL, {});
  assert.equal(result.aborted, true);
  assert.equal(result.text, '已经收到的正文');
  assert.equal(result.reasoning, '已经收到的思考');
});

test('流式：没有思考链时不返回 reasoning 字段（旧模型/旧宿主兼容）', async () => {
  const client = createChatClient(transportOf(() => [{ delta: '只有正文' }]));
  const result = await client.reply(CALL, {});
  assert.equal(result.text, '只有正文');
  assert.equal('reasoning' in result, false);
});

test('流式：content→usage→[DONE]，usage 用接口真实值并标记 estimated:false', async () => {
  const chunks: { text: string; usage?: unknown }[] = [];
  const client = createChatClient(
    transportOf(() => [
      { delta: '真实回复' },
      { usage: { promptTokens: 123, completionTokens: 45, totalTokens: 168 } },
    ]),
  );
  const result = await client.reply(CALL, { onDelta: (chunk) => chunks.push({ text: chunk.delta ?? '', ...(chunk.usage === undefined ? {} : { usage: chunk.usage }) }) });
  assert.equal(result.text, '真实回复');
  assert.deepEqual(result.usage, { promptTokens: 123, completionTokens: 45, totalTokens: 168, estimated: false });
  assert.equal(chunks.length, 2, 'usage chunk 也要透传给 onDelta');
  assert.deepEqual(chunks[1]?.usage, { promptTokens: 123, completionTokens: 45, totalTokens: 168 });
});

test('流式：没有 usage 时不伪造字段（调用方按 estimated:true 自行估算）', async () => {
  const client = createChatClient(transportOf(() => [{ delta: '只有正文' }]));
  const result = await client.reply(CALL, {});
  assert.equal('usage' in result, false);
});

test('流式 tool_calls：按 index 合并 id/name 与分片 arguments，最终返回完整调用', async () => {
  const raw: unknown[] = [];
  const client = createChatClient(
    transportOf(() => [
      { toolCalls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":' } }] },
      { toolCalls: [{ index: 0, function: { arguments: '"x"}' } }] },
      { toolCalls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { delta: 'done' },
    ]),
  );
  const result = await client.reply(CALL, { onDelta: (chunk) => raw.push(chunk) });
  assert.equal(result.text, 'done');
  assert.deepEqual(result.toolCalls, [
    { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
    { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } },
  ]);
  assert.equal(raw.length, 4, 'toolCalls 原始增量也要透传给 onDelta');
  assert.deepEqual(raw[0], { toolCalls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":' } }] });
});

test('preview：tools/toolChoice 原样传给宿主（body 由宿主统一构造）', async () => {
  const tools = [{ type: 'function' as const, function: { name: 'search', description: '搜索', parameters: { type: 'object' } } }];
  const client = createChatClient(
    transportOf((request) => {
      const call = request.args[0] as ChatCall;
      assert.deepEqual(call.tools, tools);
      assert.equal(call.toolChoice, 'auto');
      return [{ url: '', body: '', byteLength: 0, model: '' }];
    }),
  );
  await client.preview({ ...CALL, tools, toolChoice: 'auto' });
});

test('preview：走 chat.preview，原样带回 URL/body/字节数/模型名', async () => {
  const client = createChatClient(
    transportOf((request) => {
      assert.equal(request.service, 'chat');
      assert.equal(request.method, 'preview');
      const call = request.args[0] as ChatCall;
      assert.equal(call.postHistory, '本次回复请保持克制。');
      return [{ url: 'http://x/chat/completions', body: '{"stream":true}', byteLength: 15, model: 'm' }];
    }),
  );
  const preview = await client.preview(CALL);
  assert.deepEqual(preview, { url: 'http://x/chat/completions', body: '{"stream":true}', byteLength: 15, model: 'm' });
});

test('无宿主：available=false，reply/preview 都明确报 no-host（不伪造成功）', async () => {
  const client = createChatClient(undefined);
  assert.equal(client.available, false);
  await assert.rejects(client.reply(CALL, {}), /浏览器里不能直接调用模型/);
  await assert.rejects(client.preview(CALL), /浏览器里不能直接调用模型/);
});
