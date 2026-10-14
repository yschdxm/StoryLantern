import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WireError } from '../../../packages/wire/src/index.ts';
import type { TauriBridge } from '../../../packages/wire/src/tauri.ts';
import { createHostClient } from '../src/host-panel.ts';

/**
 * 假宿主：按 Rust 侧 `wire.rs` 的协议实现同样的服务。
 *
 * 这里刻意**不**复用 packages/wire 的测试辅助：apps 依赖包，不该依赖包的测试代码。
 * 代价是协议实现写两遍——但它同时也是"协议是否够清楚"的一次检验。
 */
function createFakeHost(options: { withChannel?: boolean } = {}) {
  let streamSeq = 0;
  let debugOk = 0;
  const services = [
    {
      name: 'shell',
      description: '宿主自身的能力',
      methods: [
        { name: 'info', kind: 'call', description: '' },
        { name: 'debugStats', kind: 'call', description: '' },
        { name: 'demoStream', kind: 'stream', description: '' },
      ],
    },
    {
      name: 'store',
      description: '底层存储探针',
      methods: [{ name: 'probe', kind: 'call', description: '' }],
    },
  ];

  let failure: string | null = null;

  const bridge: TauriBridge = {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (failure !== null) throw new Error(failure);
      const service = String(args?.['service'] ?? '');
      const method = String(args?.['method'] ?? '');
      const callArgs = (args?.['args'] as unknown[]) ?? [];

      if (command === 'wire_manifest') return { services } as T;
      if (command === 'wire_stream_close') return null as T;
      if (command === 'wire_stream_open') {
        const streamId = `s${(streamSeq += 1)}`;
        const channel = args?.['onEvent'] as { onmessage?: (message: unknown) => void } | undefined;
        const text = String(callArgs[0] ?? '');
        const pieces = text.match(/.{1,3}/gu) ?? [];
        void (async () => {
          for (const [index, piece] of pieces.entries()) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            debugOk += 1;
            channel?.onmessage?.({ value: { index, text: piece } });
          }
          channel?.onmessage?.({ done: true });
        })();
        return { streamId } as T;
      }
      if (command !== 'wire_invoke') throw new Error(`未知命令 ${command}`);

      if (service === 'shell' && method === 'info') {
        return { product: 'Story Lantern', version: '0.1.0', os: 'android', arch: 'x86_64' } as T;
      }
      if (service === 'shell' && method === 'debugStats') {
        return { ok: debugOk, errors: [] } as T;
      }
      if (service === 'store' && method === 'probe') {
        return {
          path: '/data/user/0/app.storylantern/files/storylantern.db',
          journal_mode: 'wal',
          page_size: 4096,
          sqlite_version: '3.50.2',
          writable: true,
          characters: 2,
          sessions: 3,
          messages: 11,
        } as T;
      }
      throw { code: 'unknown-method', message: `${service}.${method} 不存在` };
    },

    async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      void event;
      void handler;
      return () => undefined;
    },

    ...(options.withChannel === false
      ? {}
      : {
          createChannel: <T>(onMessage: (message: T) => void) => ({ onmessage: onMessage as (message: unknown) => void }),
        }),
  };

  return {
    bridge,
    get debugOk() {
      return debugOk;
    },
    fail(message: string | null) {
      failure = message;
    },
  };
}

test('宿主客户端：清单、信息与 SQLite 探针都来自宿主（snake_case 在边界处转换）', async () => {
  const fake = createFakeHost();
  const client = createHostClient(fake.bridge);

  assert.equal(client.available, true);
  assert.equal(client.transportKind, 'tauri-ipc');

  const methods = await client.describe();
  assert.ok(methods.includes('shell.info (call)'));
  assert.ok(methods.includes('shell.demoStream (stream)'));
  assert.ok(methods.includes('store.probe (call)'));

  const view = await client.load();
  assert.equal(view.error, undefined);
  assert.equal(view.info?.product, 'Story Lantern');
  assert.equal(view.sqlite?.journalMode, 'wal');
  assert.equal(view.sqlite?.pageSize, 4096);
  assert.equal(view.sqlite?.writable, true);
  assert.deepEqual(
    [view.sqlite?.characters, view.sqlite?.sessions, view.sqlite?.messages],
    [2, 3, 11],
  );
});

test('宿主客户端：Channel 流式逐片回调，结束后报告分片数与发射统计', async () => {
  const fake = createFakeHost();
  const client = createHostClient(fake.bridge);

  const seen: string[] = [];
  const result = await client.streamDemo('一二三四五六七八九', (chunk) => seen.push(chunk.text));
  assert.equal(result.cancelled, false);
  assert.equal(result.chunks, seen.length);
  assert.equal(seen.join(''), '一二三四五六七八九');
  // 假宿主每片回一次（结束帧不计数）；断言关系而不是写死数字
  assert.equal(fake.debugOk, result.chunks);

  const view = await client.load();
  assert.equal(view.streamStats?.ok, result.chunks);
  assert.deepEqual(view.streamStats?.errors, []);
});

test('宿主客户端：取消后报告 cancelled，并在第一片之后停下', async () => {
  const fake = createFakeHost();
  const client = createHostClient(fake.bridge);
  const controller = new AbortController();
  const cancelled = await client.streamDemo('一二三四五六七八九', () => controller.abort(), {
    signal: controller.signal,
  });
  assert.equal(cancelled.cancelled, true);
  assert.ok(cancelled.chunks <= 1);
});

test('宿主客户端：宿主报错时给出可读错误，而不是空白', async () => {
  const fake = createFakeHost();
  const client = createHostClient(fake.bridge);
  fake.fail('数据库被锁');
  const view = await client.load();
  assert.equal(view.available, true);
  assert.match(view.error ?? '', /数据库被锁/);
});

test('宿主客户端：纯浏览器下 available=false，流式调用报 no-host', async () => {
  const browser = createHostClient(undefined);
  assert.equal(browser.available, false);
  assert.deepEqual(await browser.describe(), []);

  const view = await browser.load();
  assert.equal(view.available, false);
  assert.equal(view.transport, 'none');
  assert.equal(view.error, undefined, '浏览器里没有宿主不是错误');

  await assert.rejects(() => browser.streamDemo('x', () => undefined), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'no-host');
    return true;
  });
});
