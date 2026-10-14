import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../../kernel/src/context.ts';
import { createKernelInspectProvider, InspectRegistry } from '../../kernel/src/inspect.ts';
import { createMemoryPair, WireClient } from '../src/client.ts';
import { WireHost } from '../src/host.ts';
import { createWireInspectProvider } from '../src/inspect.ts';
import { WireError } from '../src/transport.ts';

interface ChatApi {
  list(): Promise<string[]>;
  send(text: string): Promise<{ id: string }>;
  watch(): AsyncIterable<string>;
}

function setup(options: { latencyMs?: number; faults?: { offline?: boolean } } = {}) {
  const host = new WireHost();
  const cleanup: string[] = [];

  host.expose(
    'chat',
    {
      async list() {
        return ['m1', 'm2'];
      },
      async send(text: string) {
        return { id: `msg-${String(text).length}` };
      },
      watch(this: unknown) {
        return (async function* generate() {
          try {
            yield 'chunk-1';
            yield 'chunk-2';
            yield 'chunk-3';
          } finally {
            cleanup.push('closed');
          }
        })();
      },
    } as never,
    { description: '会话读写', methods: { watch: { kind: 'stream', description: '订阅新消息' } } },
  );

  host.expose(
    'settings',
    {
      async set(key: string, value: unknown) {
        if (key === 'boom') {
          const error = new Error('键冲突') as Error & { code: string };
          error.code = 'conflict';
          throw error;
        }
        return { key, value };
      },
      async fail() {
        throw new Error('普通错误');
      },
    } as never,
  );

  const pair = createMemoryPair({
    host,
    ...(options.latencyMs === undefined ? {} : { latencyMs: options.latencyMs }),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  });
  const client = new WireClient(pair.clientTransport);
  return { host, client, pair, cleanup };
}

test('调用往返：参数与返回值原样传递', async () => {
  const { client } = setup();
  const chat = client.service<ChatApi>('chat');
  assert.deepEqual(await chat.list(), ['m1', 'm2']);
  assert.deepEqual(await chat.send('你好'), { id: 'msg-2' });
  await client.ready();
  assert.equal(client.kindOf('chat', 'watch'), 'stream');
  assert.equal(client.kindOf('chat', 'list'), 'call');
});

test('清单驱动门面：流式方法返回 AsyncIterable，普通方法返回 Promise', async () => {
  const { client } = setup();
  await client.ready();
  const chat = client.service<ChatApi>('chat');

  const values: string[] = [];
  for await (const chunk of chat.watch()) values.push(chunk);
  assert.deepEqual(values, ['chunk-1', 'chunk-2', 'chunk-3']);

  const reported = await chat.list();
  assert.equal(Array.isArray(reported), true);
});

test('未知 Service / 未知方法：有清单时在本地立刻失败，不产生往返', async () => {
  const { client } = setup();
  await client.ready();
  await assert.rejects(() => client.call('nope', 'x'), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'unknown-service');
    return true;
  });
  await assert.rejects(() => client.call('chat', 'nope'), /unknown-method|没有方法/);
});

test('没有清单时由对端判定，错误码一致', async () => {
  const { client } = setup();
  // 不调用 ready()：客户端没有清单，交给宿主判断
  await assert.rejects(() => client.call('chat', 'missing'), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'unknown-method');
    return true;
  });
});

test('错误映射：保留 code 与 message，普通错误归为 handler-failed', async () => {
  const { client } = setup();
  await assert.rejects(() => client.call('settings', 'set', 'boom', 1), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'conflict');
    assert.equal(error.message, '键冲突');
    assert.equal(error.service, 'settings');
    return true;
  });
  await assert.rejects(() => client.call('settings', 'fail'), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'handler-failed');
    return true;
  });
});

test('契约违背：普通调用读取流式方法会明确报错而不是静默丢数据', async () => {
  const { client } = setup();
  await assert.rejects(() => client.call('chat', 'watch'), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'unexpected-stream');
    return true;
  });
});

test('取消：中断流式调用会抛出 aborted，并且宿主侧生成器被正确收尾', async () => {
  const { client, cleanup } = setup();
  await client.ready();
  const controller = new AbortController();
  const received: string[] = [];

  await assert.rejects(async () => {
    const bound = client.withSignal(controller.signal);
    for await (const chunk of bound.stream<string>('chat', 'watch')) {
      received.push(chunk);
      if (received.length === 2) controller.abort();
    }
  }, (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'aborted');
    return true;
  });

  assert.deepEqual(received, ['chunk-1', 'chunk-2']);
  assert.deepEqual(cleanup, ['closed'], '宿主生成器的 finally 必须执行');
});

test('expose 返回 disposer：撤销后该 Service 立刻不可调用；重复暴露即报错', async () => {
  const host = new WireHost();
  const off = host.expose('temporary', { async ping() { return 'pong'; } } as never);
  const pair = createMemoryPair({ host });
  const client = new WireClient(pair.clientTransport);

  assert.equal(await client.call('temporary', 'ping'), 'pong');
  assert.throws(() => host.expose('temporary', {} as never), /duplicate-service|已经暴露/);
  off();
  await assert.rejects(() => client.call('temporary', 'ping'), /unknown-service|未知 Service/);
  assert.equal(host.size, 0);
});

test('清单内容：按名字排序，kind 与描述可读', async () => {
  const { host } = setup();
  const manifest = host.manifest();
  assert.deepEqual(manifest.services.map((item) => item.name), ['chat', 'settings']);
  const chat = manifest.services[0];
  assert.equal(chat?.description, '会话读写');
  assert.deepEqual(chat?.methods.map((method) => `${method.name}:${method.kind}`), ['list:call', 'send:call', 'watch:stream']);
});

test('传输故障与关闭都有明确错误码', async () => {
  const offline = setup({ faults: { offline: true } });
  await assert.rejects(() => offline.client.call('chat', 'list'), /transport-offline|传输离线/);

  const { client, pair } = setup();
  pair.close();
  await assert.rejects(() => client.call('chat', 'list'), /transport-closed|传输已关闭/);
});

test('Inspect：宿主暴露的方法清单可被内核的 Inspect 注册表查询', async () => {
  const { host } = setup();
  const ctx = createContext();
  const registry = new InspectRegistry();
  registry.register(createKernelInspectProvider(ctx));
  registry.register(createWireInspectProvider(host));

  assert.deepEqual(registry.list().map((item) => item.id).sort(), ['Kernel', 'Wire']);

  const all = await registry.query('host', 'Wire', 'manifest');
  assert.equal(all.ok, true);
  const filtered = await registry.query('host', 'Wire', 'listMethods', { service: 'chat' });
  assert.deepEqual(filtered.data, { services: [{ name: 'chat', methods: ['list (call)', 'send (call)', 'watch (stream)'] }] });

  const missing = await registry.query('host', 'Wire', 'nope');
  assert.equal(missing.ok, false);
});
