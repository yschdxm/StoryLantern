import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRequestLogEntry,
  createDeviceRequestLog,
  createMemoryRequestLog,
  makeRequestLogEntry,
  parseRequestLog,
  REQUEST_LOG_BODY_BYTES,
  REQUEST_LOG_KEY,
  REQUEST_LOG_LIMIT,
  serializeRequestLog,
  truncateBody,
  type RequestLogEntry,
} from '../src/data/request-log.ts';

/** 假设备 kv：验证"宿主席位"这条路径（写进 request.log.*，不碰同步 settings）。 */
function fakeDevice(): {
  data: Map<string, string>;
  device: { get(key: string): Promise<string | undefined>; set(key: string, value: string): Promise<void> };
} {
  const data = new Map<string, string>();
  return {
    data,
    device: {
      async get(key: string) {
        return data.get(key);
      },
      async set(key: string, value: string) {
        data.set(key, value);
      },
    },
  };
}

function entry(n: number, patch: Partial<RequestLogEntry> = {}): RequestLogEntry {
  return makeRequestLogEntry({
    id: `req-${n}`,
    at: 1_700_000_000_000 + n,
    sessionId: 'S1',
    model: 'deepseek-chat',
    url: 'http://x/chat/completions',
    byteLength: 10,
    body: `{"n":${n}}`,
    status: 'ok',
    ...patch,
  });
}

test('FIFO：最多保留最近 20 条，新的在前、最旧的被挤掉', () => {
  let list: RequestLogEntry[] = [];
  for (let n = 1; n <= 25; n += 1) list = appendRequestLogEntry(list, entry(n));
  assert.equal(list.length, REQUEST_LOG_LIMIT);
  assert.equal(list[0]?.id, 'req-25', '最新在前');
  assert.equal(list[REQUEST_LOG_LIMIT - 1]?.id, 'req-6', '最旧的 1..5 被挤掉');
  assert.equal(REQUEST_LOG_LIMIT, 20);
});

test('body 截断：UTF-8 字节上限 64 KiB，截断标记也算在上限内', () => {
  const huge = '灯'.repeat(40_000); // 中文 3 字节 → 120KB
  const truncated = truncateBody(huge);
  const bytes = new TextEncoder().encode(truncated);
  assert.ok(bytes.length <= REQUEST_LOG_BODY_BYTES, `截断后 ${bytes.length} 字节，必须 ≤ ${REQUEST_LOG_BODY_BYTES}`);
  assert.ok(truncated.endsWith('[truncated]'), '要明确标记被截断，不能假装完整');
  assert.equal(truncateBody('短文本'), '短文本');
  // 截断发生在 append 里（调用方不必自己截）
  const list = appendRequestLogEntry([], entry(1, { body: huge }));
  assert.ok(new TextEncoder().encode(list[0]?.body ?? '').length <= REQUEST_LOG_BODY_BYTES);
});

test('设备 kv 持久化：append → list 读回；坏 JSON/坏条目被跳过；clear 清空', async () => {
  const { data, device } = fakeDevice();
  const log = createDeviceRequestLog(device);
  await log.append(entry(1, { status: 'error', body: '{"failed":true}' }));
  await log.append(entry(2));
  const listed = await log.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0]?.id, 'req-2', '新的在前');
  assert.equal(listed[1]?.status, 'error', '错误条目也要能往返');

  assert.ok(data.has(REQUEST_LOG_KEY), '写在 request.log.* 键上');
  assert.ok([...data.keys()].every((key) => key.startsWith('request.log.')), '不能写进同步 settings 键');

  data.set(REQUEST_LOG_KEY, '{不是 JSON');
  assert.deepEqual(await log.list(), [], '坏 JSON 当空，不让 Inspector 打不开');

  data.set(REQUEST_LOG_KEY, JSON.stringify([{ id: 'bad' }, entry(3), null]));
  assert.deepEqual((await log.list()).map((item) => item.id), ['req-3'], '坏条目跳过、好条目保留');

  await log.clear();
  assert.deepEqual(await log.list(), []);
});

test('内存实现与序列化：错误条目、时间字段都保留', async () => {
  const log = createMemoryRequestLog();
  await log.append(entry(1, { status: 'error', firstDeltaMs: 12, totalMs: 300 }));
  const listed = await log.list();
  assert.equal(listed[0]?.status, 'error');
  assert.equal(listed[0]?.firstDeltaMs, 12);
  assert.equal(listed[0]?.totalMs, 300);
  assert.deepEqual(parseRequestLog(serializeRequestLog(listed)), listed);
});
