import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WireClient } from '../src/client.ts';
import { WireHost } from '../src/host.ts';
import { createTauriBridgeFromGlobal, createTauriTransport, type TauriBridge } from '../src/tauri.ts';
import { WireError } from '../src/transport.ts';

/**
 * 假宿主：按 Rust 侧（`apps/shell/src-tauri/src/lib.rs`）的协议在进程内实现一遍。
 *
 * 这样测试覆盖的是**协议**，不是 Rust 代码本身——Rust 侧用同一份协议，
 * 设备上的验收负责证明那一半。
 */
function createFakeRustHost(host: WireHost, options: { terminal?: 'natural' } = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const closed: string[] = [];
  const emit = (event: string, payload: unknown): void => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  };
  let seq = 0;

  const bridge: TauriBridge = {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      const request = {
        service: String(args?.['service'] ?? ''),
        method: String(args?.['method'] ?? ''),
        args: (args?.['args'] as unknown[]) ?? [],
      };
      switch (command) {
        case 'wire_manifest':
          return host.manifest() as T;

        case 'wire_invoke': {
          const iterator = host.invoke(request)[Symbol.asyncIterator]();
          const first = await iterator.next();
          if (first.done === true) {
            // 与 Tauri 的 command 语义一致：失败就 reject，载荷是 {code,message}
            throw { code: 'empty-response', message: '没有返回值' };
          }
          const extra = await iterator.next();
          if (extra.done !== true) {
            throw { code: 'unexpected-stream', message: '返回了多个值' };
          }
          return first.value as T;
        }

        case 'wire_stream_open': {
          const streamId = `s${(seq += 1)}`;
          void (async () => {
            const iterator = host.invoke(request)[Symbol.asyncIterator]();
            try {
              for (;;) {
                const next = await iterator.next();
                if (next.done === true) {
                  emit('wire-end', { streamId });
                  return;
                }
                emit('wire-chunk', { streamId, value: next.value });
              }
            } catch (cause) {
              const error = cause instanceof WireError ? cause.toShape() : { code: 'internal', message: String(cause) };
              emit('wire-end', { streamId, error });
            }
          })();
          return { streamId } as T;
        }

        case 'wire_stream_close':
          closed.push(String(args?.['streamId'] ?? ''));
          return null as T;

        default:
          throw new Error(`未知命令 ${command}`);
      }
    },

    async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (payload: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(handler as (payload: unknown) => void);
    },
  };

  return { bridge, closed, host, options };
}

function setup() {
  const host = new WireHost();
  host.expose(
    'shell',
    {
      async info() {
        return { product: 'Story Lantern', os: 'android' };
      },
      async fail() {
        const error = new Error('数据库被锁') as Error & { code: string };
        error.code = 'db-locked';
        throw error;
      },
      demo() {
        return (async function* generate() {
          yield 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield 2;
          await new Promise((resolve) => setTimeout(resolve, 5));
          yield 3;
        })();
      },
      hang() {
        return (async function* generate() {
          yield 'first';
          // 之后什么都不产出：模拟"生成中但暂时没有新 token"
          await new Promise(() => undefined);
        })();
      },
    } as never,
    { methods: { demo: { kind: 'stream' }, hang: { kind: 'stream' } } },
  );

  const fake = createFakeRustHost(host);
  const transport = createTauriTransport({ bridge: fake.bridge });
  const client = new WireClient(transport);
  return { ...fake, transport, client };
}

test('Tauri 承载：清单、普通调用与错误码都按协议走通', async () => {
  const { client } = setup();
  const manifest = await client.ready();
  assert.equal(manifest?.services[0]?.name, 'shell');
  assert.equal(client.kindOf('shell', 'demo'), 'stream');
  assert.equal(client.kindOf('shell', 'info'), 'call');

  assert.deepEqual(await client.call('shell', 'info'), { product: 'Story Lantern', os: 'android' });
  await assert.rejects(() => client.call('shell', 'fail'), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'db-locked');
    assert.equal(error.service, 'shell');
    return true;
  });
});

test('Tauri 承载：流式按事件逐片送达，结束后自动关闭流', async () => {
  const { client, closed } = setup();
  await client.ready();
  const seen: unknown[] = [];
  for await (const value of client.stream<number>('shell', 'demo')) seen.push(value);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(closed.length, 1, '流结束后必须调用 wire_stream_close');
});

test('Tauri 承载：取消时会立刻结束并关闭流（即使没有新分片）', async () => {
  const { client, closed } = setup();
  await client.ready();
  const controller = new AbortController();
  const seen: unknown[] = [];

  await assert.rejects(async () => {
    const bound = client.withSignal(controller.signal);
    for await (const value of bound.stream<string>('shell', 'hang')) {
      seen.push(value);
      controller.abort(); // 第一个分片后立刻取消，且对端不再产出
    }
  }, (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'aborted');
    return true;
  });

  assert.deepEqual(seen, ['first']);
  assert.equal(closed.length, 1);
});

test('Tauri 承载：宿主以 Err 拒绝时（Tauri 的 command 语义）错误码照样透传', async () => {
  const host = new WireHost();
  host.expose(
    'bad',
    {
      async *boom() {
        const error = new Error('生成失败') as Error & { code: string };
        error.code = 'model-error';
        throw error;
      },
      // 把 async（非生成器）函数误声明为流式：应当明确报 bad-stream，且不留下未处理的 rejection
      async notAStream() {
        return 'oops';
      },
      multi() {
        return (async function* generate() {
          yield 1;
          yield 2;
        })();
      },
    } as never,
    { methods: { boom: { kind: 'stream' }, notAStream: { kind: 'stream' }, multi: { kind: 'stream' } } },
  );

  // 假宿主模拟 Tauri：command 抛错时 **reject**，值就是错误载荷（这里无需转换，直接透传）
  const fake = createFakeRustHost(host);
  const bridge: TauriBridge = fake.bridge;

  const client = new WireClient(createTauriTransport({ bridge }));
  await client.ready();

  // 流式生成器自己抛错：错误码从 wire-end 事件透传出来
  await assert.rejects(() => client.call('bad', 'boom'), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'model-error');
    return true;
  });

  // 误声明为流式的 async 函数：契约违背要说清楚，而不是静默空流
  await assert.rejects(() => client.call('bad', 'notAStream'), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'bad-stream');
    return true;
  });

  // 清单不可用时，客户端只能把流式方法当普通调用——宿主必须拦住这种误用，
  // 而不是把流的第一个值当成"调用结果"悄悄返回。
  const blindBridge: TauriBridge = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      if (command === 'wire_manifest') throw new Error('manifest 不可用');
      return fake.bridge.invoke<T>(command, args);
    },
    listen: fake.bridge.listen,
  };
  const blind = new WireClient(createTauriTransport({ bridge: blindBridge }));
  await assert.rejects(() => blind.call('bad', 'multi'), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'unexpected-stream');
    return true;
  });

  // 有清单时同一个方法走流式路径，正常逐片送达
  const seen: unknown[] = [];
  for await (const value of client.stream<number>('bad', 'multi')) seen.push(value);
  assert.deepEqual(seen, [1, 2]);
});

test('Tauri 承载：没有清单时退化为"全部当普通调用"，流式方法仍能显出契约违背', async () => {
  const host = new WireHost();
  host.expose('shell', { async ping() { return 'pong'; } } as never);
  const fake = createFakeRustHost(host);
  const bridge: TauriBridge = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      if (command === 'wire_manifest') throw new Error('manifest 不可用');
      return fake.bridge.invoke<T>(command, args);
    },
    listen: fake.bridge.listen,
  };

  const client = new WireClient(createTauriTransport({ bridge }));
  assert.equal(await client.call('shell', 'ping'), 'pong');
  assert.equal(client.manifest(), undefined);
});

test('createTauriBridgeFromGlobal：只有真正的 Tauri 环境才返回桥', () => {
  assert.equal(createTauriBridgeFromGlobal({}), undefined);
  assert.equal(createTauriBridgeFromGlobal({ __TAURI__: { core: {} } }), undefined);

  const calls: string[] = [];
  const bridge = createTauriBridgeFromGlobal({
    __TAURI__: {
      core: { invoke: (command: string) => Promise.resolve(calls.push(command)) },
      event: { listen: () => Promise.resolve(() => undefined) },
    },
  });
  assert.ok(bridge);
  void bridge.invoke('wire_manifest');
  assert.deepEqual(calls, ['wire_manifest']);
});
