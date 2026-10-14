import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WireError } from '../../../packages/wire/src/index.ts';
import type { TauriBridge } from '../../../packages/wire/src/tauri.ts';
import { createHostClient } from '../src/host-panel.ts';

/**
 * 假宿主：按 Rust 侧 `wire.rs` 的协议实现同样的两个服务。
 *
 * 这里刻意**不**复用 packages/wire 的测试辅助：apps 依赖包，不该依赖包的测试代码。
 * 代价是协议实现写两遍——但它同时也是"协议是否够清楚"的一次检验（写第二遍时没卡住）。
 */
function createFakeHost() {
  const notes: Array<{ id: number; body: string; created_at: number }> = [];
  let nextId = 1;
  let streamSeq = 0;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const closed: string[] = [];
  let failure: string | null = null;

  const emit = (event: string, payload: unknown): void => {
    for (const handler of listeners.get(event) ?? []) handler(payload);
  };

  const services = [
    {
      name: 'shell',
      description: '宿主自身的能力',
      methods: [
        { name: 'info', kind: 'call', description: '' },
        { name: 'demoStream', kind: 'stream', description: '' },
      ],
    },
    {
      name: 'store',
      description: '宿主侧 SQLite',
      methods: [
        { name: 'probe', kind: 'call', description: '' },
        { name: 'listNotes', kind: 'call', description: '' },
        { name: 'addNote', kind: 'call', description: '' },
        { name: 'deleteNote', kind: 'call', description: '' },
      ],
    },
  ];

  const bridge: TauriBridge = {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      if (failure !== null) throw new Error(failure);
      const service = String(args?.['service'] ?? '');
      const method = String(args?.['method'] ?? '');
      const callArgs = (args?.['args'] as unknown[]) ?? [];

      if (command === 'wire_manifest') return { services } as T;
      if (command === 'wire_stream_close') {
        closed.push(String(args?.['streamId'] ?? ''));
        return null as T;
      }
      if (command === 'wire_stream_open') {
        const streamId = `s${(streamSeq += 1)}`;
        const text = String(callArgs[0] ?? '');
        const pieces = text.match(/.{1,3}/gu) ?? [];
        void (async () => {
          for (const [index, piece] of pieces.entries()) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            emit('wire-chunk', { streamId, value: { index, text: piece } });
          }
          emit('wire-end', { streamId });
        })();
        return { streamId } as T;
      }
      if (command !== 'wire_invoke') throw new Error(`未知命令 ${command}`);

      if (service === 'shell' && method === 'info') {
        return { product: 'Story Lantern', version: '0.0.1', os: 'android', arch: 'x86_64' } as T;
      }
      if (service === 'store' && method === 'probe') {
        return {
          path: '/data/data/app.storylantern/files/storylantern-spike.db',
          journal_mode: 'wal',
          page_size: 4096,
          sqlite_version: '3.50.0',
          notes: notes.length,
          writable: true,
        } as T;
      }
      if (service === 'store' && method === 'listNotes') {
        return [...notes].reverse() as T;
      }
      if (service === 'store' && method === 'addNote') {
        const body = String(callArgs[0] ?? '').trim();
        if (body === '') throw { code: 'invalid-argument', message: '便签内容不能为空' };
        notes.push({ id: nextId, body, created_at: 1_700_000_000_000 + nextId });
        nextId += 1;
        return notes[notes.length - 1] as T;
      }
      if (service === 'store' && method === 'deleteNote') {
        const id = Number(callArgs[0]);
        const index = notes.findIndex((note) => note.id === id);
        if (index < 0) return { removed: false } as T;
        notes.splice(index, 1);
        return { removed: true } as T;
      }
      throw { code: 'unknown-method', message: `${service}.${method} 不存在` };
    },

    async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as (payload: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(handler as (payload: unknown) => void);
    },
  };

  return {
    bridge,
    closed,
    fail(message: string | null) {
      failure = message;
    },
  };
}

test('宿主面板：清单、信息、SQLite 探针与便签都从宿主来（snake_case 在边界处转换）', async () => {
  const fake = createFakeHost();
  const client = createHostClient(fake.bridge);

  assert.equal(client.available, true);
  assert.equal(client.transportKind, 'tauri-ipc');

  const methods = await client.describe();
  assert.ok(methods.includes('shell.info (call)'));
  assert.ok(methods.includes('shell.demoStream (stream)'));
  assert.ok(methods.includes('store.addNote (call)'));

  const view = await client.load();
  assert.equal(view.error, undefined);
  assert.equal(view.info?.product, 'Story Lantern');
  assert.equal(view.sqlite?.journalMode, 'wal');
  assert.equal(view.sqlite?.pageSize, 4096);
  assert.equal(view.sqlite?.writable, true);
  assert.equal(view.notes.length, 0);
});

test('宿主面板：写入/删除走宿主，刷新后数量与内容一致', async () => {
  const fake = createFakeHost();
  const client = createHostClient(fake.bridge);

  await client.addNote('第一条');
  await client.addNote('第二条');
  let view = await client.load();
  assert.deepEqual(view.notes.map((note) => note.body), ['第二条', '第一条']);
  assert.equal(view.sqlite?.notes, 2);

  await client.deleteNote(view.notes[0]!.id);
  view = await client.load();
  assert.deepEqual(view.notes.map((note) => note.body), ['第一条']);

  // 宿主的校验错误要带着 code 传上来
  await assert.rejects(() => client.addNote('   '), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'invalid-argument');
    return true;
  });
});

test('宿主面板：流式逐片回调，结束后报告分片数；取消时报告 cancelled', async () => {
  const fake = createFakeHost();
  const client = createHostClient(fake.bridge);

  const seen: string[] = [];
  const result = await client.streamDemo('一二三四五六七八九', (chunk) => seen.push(chunk.text));
  assert.equal(result.cancelled, false);
  assert.equal(result.chunks, seen.length);
  assert.equal(seen.join(''), '一二三四五六七八九');
  assert.equal(fake.closed.length, 1, '流结束后应当关闭');

  // 立刻取消：应当在第一片之后就停下
  const controller = new AbortController();
  const cancelled = await client.streamDemo('一二三四五六七八九', () => controller.abort(), { signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
  assert.ok(cancelled.chunks <= 1);
});

test('宿主面板：宿主不可用时给出明确错误，而不是静默空白', async () => {
  const fake = createFakeHost();
  const client = createHostClient(fake.bridge);
  fake.fail('数据库被锁');

  const view = await client.load();
  assert.equal(view.available, true);
  assert.match(view.error ?? '', /数据库被锁/);
  assert.deepEqual(view.notes, []);
});

test('宿主面板：纯浏览器下 available=false，且操作抛出可读的 no-host 错误', async () => {
  const browser = createHostClient(undefined);
  assert.equal(browser.available, false);
  assert.deepEqual(await browser.describe(), []);

  const view = await browser.load();
  assert.equal(view.available, false);
  assert.equal(view.transport, 'none');
  assert.equal(view.error, undefined, '浏览器里没有宿主不是错误');

  await assert.rejects(() => browser.addNote('x'), (error: unknown) => {
    assert.ok(error instanceof WireError);
    assert.equal(error.code, 'no-host');
    return true;
  });
});
