import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSafFilePort, createSafFolderBackend, decodeBase64, encodeBase64 } from '../src/data/saf-folder.ts';
import type { TauriBridge } from '../../../packages/wire/src/index.ts';

/**
 * SAF 文件端口：**用假插件跑**，把"该怎么调插件"钉住。
 *
 * 真机上这部分已经验证过一轮（选目录 → 授权 → 界面显示已选），
 * 这里要证明的是：端口把插件的返回值翻译对了（大小/时间/条件写/删除），
 * 而且能被既有的同步后端直接复用。
 */

interface Call {
  command: string;
  args: Record<string, unknown>;
}

/** 假插件：内存里放一个"选中目录"。 */
function fakeBridge(): { bridge: TauriBridge; calls: Call[]; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const calls: Call[] = [];

  const bridge = {
    async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
      calls.push({ command, args: args ?? {} });
      if (command === 'plugin:saf|list') {
        const prefix = String(args?.prefix ?? '');
        const entries = [...files.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, bytes]) => ({ path, size: bytes.length, mtime: 1_700_000_000_000 }));
        return { entries } as T;
      }
      if (command === 'plugin:saf|read') {
        const bytes = files.get(String(args?.path ?? ''));
        if (bytes === undefined) throw new Error('文件不存在');
        return { base64: encodeBase64(bytes) } as T;
      }
      if (command === 'plugin:saf|write') {
        const path = String(args?.path ?? '');
        if (args?.ifNoneMatch === true && files.has(path)) return { ok: false, exists: true } as T;
        files.set(path, decodeBase64(String(args?.base64 ?? '')));
        return { ok: true } as T;
      }
      if (command === 'plugin:saf|remove') {
        const removed = files.delete(String(args?.path ?? ''));
        return { removed } as T;
      }
      throw new Error(`没实现的命令：${command}`);
    },
  } as unknown as TauriBridge;

  return { bridge, calls, files };
}

test('base64 往返：二进制不丢字节', () => {
  const bytes = Uint8Array.from([0, 1, 127, 128, 255, 42]);
  assert.deepEqual([...decodeBase64(encodeBase64(bytes))], [...bytes]);
});

test('SAF 端口：读写删与"不存在才写"都按插件的语义翻译', async () => {
  const { bridge, calls, files } = fakeBridge();
  const port = createSafFilePort(bridge);

  const first = await port.write('logs/a.jsonl', Uint8Array.from([1, 2, 3]));
  assert.deepEqual(first, { ok: true });
  assert.deepEqual([...files.get('logs/a.jsonl')!], [1, 2, 3]);

  // 条件写：已存在就必须拒绝，否则两台设备会互相覆盖
  const again = await port.write('logs/a.jsonl', Uint8Array.from([9]), { ifNoneMatch: true });
  assert.deepEqual(again, { ok: false, exists: true });
  assert.deepEqual([...files.get('logs/a.jsonl')!], [1, 2, 3], '被拒绝时不能改动内容');

  const read = await port.read('logs/a.jsonl');
  assert.deepEqual([...read], [1, 2, 3]);

  const listed = await port.list('logs/');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.path, 'logs/a.jsonl');
  assert.equal(listed[0]!.size, 3);
  assert.equal(typeof listed[0]!.mtime, 'number');

  await port.delete('logs/a.jsonl');
  assert.equal(files.has('logs/a.jsonl'), false);

  // 参数名要对上 Kotlin 侧：path / base64 / ifNoneMatch / prefix
  const wrote = calls.find((call) => call.command === 'plugin:saf|write');
  assert.deepEqual(Object.keys(wrote!.args).sort(), ['base64', 'ifNoneMatch', 'path']);
  assert.equal(calls.some((call) => call.command === 'plugin:saf|list' && call.args.prefix === 'logs/'), true);
});

test('SAF 后端：直接复用同步后端（list/put/get/delete 都能走通）', async () => {
  const { bridge } = fakeBridge();
  const backend = createSafFolderBackend(bridge);
  assert.equal(backend.id, 'folder');

  await backend.put('devices/x-1.json', Uint8Array.from([7, 7]));
  const got = await backend.get('devices/x-1.json');
  assert.deepEqual([...got], [7, 7]);

  const list = await backend.list('devices/');
  assert.equal(list.entries.length, 1);
  assert.equal(list.entries[0]!.path, 'devices/x-1.json');

  await backend.delete?.('devices/x-1.json');
  await assert.rejects(() => backend.get('devices/x-1.json'));
});
