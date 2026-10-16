import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createS3Backend, registerS3Backend } from '../src/index.ts';

/**
 * S3 后端的**语义**测试：用注入的 fetch 造一个假 S3，验四个动作与能力探测。
 *
 * 为什么值得单独测：同步协议把"共享文件只写一次"压在**条件写**上（内容寻址 + If-None-Match）。
 * 如果后端把 412 当成普通失败，或者列目录少返回一条，同步会**静默**变慢或漏段 —— 这两类都不报错。
 */

interface FakeS3 {
  fetch: typeof fetch;
  objects: Map<string, Uint8Array>;
  requests: string[];
}

function createFakeS3(options: { pageSize?: number; noConditional?: boolean } = {}): FakeS3 {
  const objects = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const pageSize = options.pageSize ?? 1000;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers ?? {});
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''));
    requests.push(`${method} ${url.pathname}${url.search}`);

    // 结构性的签名检查：真验签名是 s3-signing.test.ts 的活儿，这里只保证"该带的头都带上了"
    assert.match(headers.get('authorization') ?? '', /^AWS4-HMAC-SHA256 /, '必须带 SigV4 授权头');
    assert.notEqual(headers.get('x-amz-content-sha256'), null, '必须带 payload 哈希');

    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const cursor = Number(url.searchParams.get('continuation-token') ?? '0');
      const all = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
      const page = all.slice(cursor, cursor + pageSize);
      const truncated = cursor + page.length < all.length;
      const body =
        '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>' +
        page
          .map(
            (name) =>
              `<Contents><Key>${encodeURIComponent(name)}</Key><Size>${objects.get(name)?.length ?? 0}</Size>` +
              `<LastModified>2024-01-01T00:00:00.000Z</LastModified><ETag>&quot;abc&quot;</ETag></Contents>`,
          )
          .join('') +
        `<IsTruncated>${truncated}</IsTruncated>` +
        (truncated ? `<NextContinuationToken>${cursor + page.length}</NextContinuationToken>` : '') +
        '</ListBucketResult>';
      return new Response(body, { status: 200 });
    }

    if (method === 'GET') {
      const value = objects.get(key);
      if (value === undefined) return new Response('missing', { status: 404 });
      if (headers.get('range') !== null) {
        return new Response(value.slice(0, 1), { status: 206 });
      }
      return new Response(value as unknown as BodyInit, { status: 200 });
    }

    if (method === 'PUT') {
      if (objects.has(key) && headers.get('if-none-match') === '*' && options.noConditional !== true) {
        return new Response('exists', { status: 412 });
      }
      objects.set(key, new Uint8Array(init?.body as ArrayBufferLike as ArrayBuffer));
      return new Response(null, { status: 200 });    }

    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }

    return new Response('bad', { status: 400 });
  }) as typeof fetch;

  return { fetch: fetchImpl, objects, requests };
}

function backendWith(fake: FakeS3, overrides: Record<string, unknown> = {}) {
  return createS3Backend({
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'bucket',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    fetch: fake.fetch,
    ...overrides,
  });
}

test('四个动作：写入 → 条件写拿到 exists → 读回一致 → 删除', async () => {
  const fake = createFakeS3();
  const backend = backendWith(fake);
  const payload = new TextEncoder().encode('hello');

  assert.deepEqual(await backend.put('logs/a.jsonl.gz', payload), { ok: true });
  assert.deepEqual(
    await backend.put('logs/a.jsonl.gz', payload, { ifNoneMatch: true }),
    { ok: false, exists: true },
    '412 必须翻译成"已存在"，不是失败 —— 内容寻址下它等价于"这次写入多余"',
  );
  assert.deepEqual([...(await backend.get('logs/a.jsonl.gz'))], [...payload]);
  await backend.delete?.('logs/a.jsonl.gz');
  await assert.rejects(() => backend.get('logs/a.jsonl.gz'));
});

test('列目录：按前缀过滤、带大小，并且支持分页游标', async () => {
  const fake = createFakeS3({ pageSize: 1 });
  const backend = backendWith(fake);
  for (const name of ['logs/x1.gz', 'logs/x2.gz', 'devices/y1.gz']) {
    await backend.put(name, new Uint8Array([1, 2, 3]));
  }

  const first = await backend.list('logs/');
  assert.deepEqual(first.entries.map((entry) => entry.path), ['logs/x1.gz'], '前缀过滤 + 每页 1 条');
  assert.equal(first.entries[0]?.size, 3);
  assert.ok(first.cursor !== undefined, '还有下一页时要给游标');

  const second = await backend.list('logs/', { cursor: first.cursor });
  assert.deepEqual(second.entries.map((entry) => entry.path), ['logs/x2.gz']);
  assert.equal(second.cursor, undefined, '最后一页不该给游标');

  const devices = await backend.list('devices/');
  assert.deepEqual(devices.entries.map((entry) => entry.path), ['devices/y1.gz']);
});

test('能力探测：条件写/范围读/删除都真实探一遍，而不是硬编码 true', async () => {
  const fake = createFakeS3();
  const backend = backendWith(fake);
  const capabilities = await backend.probe();
  assert.equal(capabilities.conditionalPut, true);
  assert.equal(capabilities.rangeRead, true);
  assert.equal(capabilities.delete, true);
  assert.equal(capabilities.listPagination, true);

  // 对端不支持条件写时，探测必须如实降级（同步会因此改用"先读后写"的保守路径）
  const noConditional = backendWith(createFakeS3({ noConditional: true }));
  assert.equal((await noConditional.probe()).conditionalPut, false);
  assert.equal(fake.requests.length > 0, true, '探测要真发请求');
});

test('路径式 URL：桶在路径里；非 ASCII 与斜杠都按段编码', async () => {
  const fake = createFakeS3();
  const backend = withEncoding(fake);
  await backend.put('sessions/会话 1/abc.json.gz', new Uint8Array([9]));
  const request = fake.requests[fake.requests.length - 1] ?? '';
  assert.equal(request.startsWith('PUT /bucket/sessions/'), true, `路径式：桶在路径里，实际 ${request}`);
  assert.equal(request.includes('%20'), true, '空格必须编码');
  assert.equal(request.includes('会话'), false, '非 ASCII 不能原样出现');
});

function withEncoding(fake: FakeS3) {
  return createS3Backend({
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'bucket',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    fetch: fake.fetch,
  });
}

test('插件注册：把后端工厂挂到 sync.backend.s3（与 WebDAV 同一套约定）', () => {
  const registered = new Map<string, unknown>();
  registerS3Backend({ set: (key, value) => registered.set(key, value) });
  const entry = registered.get('sync.backend.s3') as { kind: string; create: unknown };
  assert.equal(entry.kind, 's3');
  assert.equal(typeof entry.create, 'function');
});
