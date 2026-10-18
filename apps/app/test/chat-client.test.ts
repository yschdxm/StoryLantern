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
