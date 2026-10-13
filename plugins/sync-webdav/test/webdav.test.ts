import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HlcClock } from '../../../packages/oplog/src/hlc.ts';
import { Materializer } from '../../../packages/oplog/src/materialize.ts';
import { messageAppend, type Op } from '../../../packages/oplog/src/op.ts';
import {
  createAesGcmCipher,
  createDeviceSigner,
  createRosterVerifier,
  generateDeviceKeyPair,
  nodeDigest,
  nodeGzip,
  type DeviceKeyPair,
} from '../../../packages/oplog/src/node-adapters.ts';
import type { CryptoPorts } from '../../../packages/oplog/src/ports.ts';
import { SyncEngine } from '../../../packages/sync-core/src/engine.ts';
import { DeviceRosterList, type DeviceRecord } from '../../../packages/sync-core/src/roster.ts';
import { createWebDavBackend, encodeDavPath, parseMultistatus } from '../src/index.ts';

// ---------------------------------------------------------------- mock WebDAV

interface MockDavOptions {
  conditionalPut?: boolean;
  rangeRead?: boolean;
  allowDelete?: boolean;
}

interface MockDav {
  url: string;
  files: Map<string, Uint8Array>;
  requests: string[];
  close(): Promise<void>;
}

/** 一个够用的 WebDAV 服务端：PROPFIND / GET / PUT / DELETE（含 412 与 206）。 */
async function startMockDav(options: MockDavOptions = {}): Promise<MockDav> {
  const conditionalPut = options.conditionalPut ?? true;
  const rangeRead = options.rangeRead ?? true;
  const allowDelete = options.allowDelete ?? true;
  const files = new Map<string, Uint8Array>();
  const requests: string[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawPath = (req.url ?? '/').split('?')[0] as string;
    const path = decodeURIComponent(rawPath).replace(/^\/dav\/?/, '');
    requests.push(`${req.method ?? 'GET'} ${path}`);

    const body = async (): Promise<Uint8Array> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      return new Uint8Array(Buffer.concat(chunks));
    };

    const run = async (): Promise<void> => {
      if (req.method === 'PROPFIND') {
        const under = [...files.keys()].filter((key) => key === path || key.startsWith(`${path}/`));
        if (under.length === 0) {
          res.writeHead(404).end();
          return;
        }
        const children = new Set<string>();
        for (const key of under) {
          const rest = key.slice(path === '' ? 0 : path.length + 1);
          const head = rest.split('/')[0];
          if (head !== undefined && head !== '') children.add(path === '' ? head : `${path}/${head}`);
        }
        const parts = ['<?xml version="1.0" encoding="utf-8"?>', '<d:multistatus xmlns:d="DAV:">'];
        parts.push(`<d:response><d:href>/dav/${encodeDavPath(path)}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`);
        for (const child of children) {
          const isDir = under.some((key) => key.startsWith(`${child}/`));
          const size = files.get(child)?.length ?? 0;
          parts.push(
            `<d:response><d:href>/dav/${encodeDavPath(child)}</d:href><d:propstat><d:prop>` +
              `<d:getcontentlength>${size}</d:getcontentlength>` +
              `<d:getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</d:getlastmodified>` +
              `<d:getetag>"etag-${child.length}"</d:getetag>` +
              (isDir ? '<d:resourcetype><d:collection/></d:resourcetype>' : '<d:resourcetype/>') +
              `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
          );
        }
        parts.push('</d:multistatus>');
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' }).end(parts.join(''));
        return;
      }

      if (req.method === 'GET') {
        const bytes = files.get(path);
        if (!bytes) {
          res.writeHead(404).end();
          return;
        }
        const range = req.headers.range;
        if (rangeRead && typeof range === 'string' && range.startsWith('bytes=0-0')) {
          res.writeHead(206, { 'content-range': `bytes 0-0/${bytes.length}`, 'content-length': '1' }).end(Buffer.from(bytes.subarray(0, 1)));
          return;
        }
        res.writeHead(200, { 'content-length': String(bytes.length) }).end(Buffer.from(bytes));
        return;
      }

      if (req.method === 'PUT') {
        if (conditionalPut && req.headers['if-none-match'] === '*' && files.has(path)) {
          res.writeHead(412).end();
          return;
        }
        files.set(path, await body());
        res.writeHead(201).end();
        return;
      }

      if (req.method === 'DELETE') {
        if (!allowDelete) {
          res.writeHead(405).end();
          return;
        }
        res.writeHead(files.delete(path) ? 204 : 404).end();
        return;
      }

      res.writeHead(405).end();
    };

    void run();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/dav/`,
    files,
    requests,
    // fetch 默认保持 keep-alive，必须先断开已有连接，否则 close() 会一直等下去。
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

// ---------------------------------------------------------------- 同步装置

function harness(url: string, deviceId: string, keys: DeviceKeyPair, roster: DeviceRosterList, blindKey: Uint8Array) {
  const ports: CryptoPorts = {
    digest: nodeDigest,
    compressor: nodeGzip,
    signer: createDeviceSigner(keys),
    verifier: createRosterVerifier(roster.toVerifierMap()),
    cipher: createAesGcmCipher({ key: new Uint8Array(32).fill(9) }),
  };
  return new SyncEngine({
    deviceId,
    backend: createWebDavBackend({ baseUrl: url }),
    ports,
    roster,
    blindKey,
    clock: new HlcClock({ now: () => 1_700_000_000_000 }),
  });
}

// ---------------------------------------------------------------- 测试

test('WebDAV 路径编码：中文与空格目录不会被写坏', () => {
  assert.equal(encodeDavPath('logs/dev-a/我的 会话/00000001-ab.jsonl.gz'), 'logs/dev-a/%E6%88%91%E7%9A%84%20%E4%BC%9A%E8%AF%9D/00000001-ab.jsonl.gz');
});

test('multistatus 解析：兼容带前缀与不带前缀的命名空间，并跳过目录', () => {
  const xml = [
    '<?xml version="1.0"?>',
    '<multistatus xmlns="DAV:">',
    '<response><href>/dav/logs/a/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>',
    '<response><href>/dav/logs/a/00000001-ab.jsonl.gz</href><propstat><prop>',
    '<getcontentlength>1234</getcontentlength><getlastmodified>Wed, 01 Jan 2025 00:00:00 GMT</getlastmodified><getetag>"xyz"</getetag>',
    '</prop><status>HTTP/1.1 200 OK</status></propstat></response>',
    '</multistatus>',
  ].join('');

  const entries = parseMultistatus(xml, '/dav');
  assert.equal(entries.length, 1, '目录条目必须被跳过');
  assert.equal(entries[0]?.path, 'logs/a/00000001-ab.jsonl.gz');
  assert.equal(entries[0]?.size, 1234);
  assert.equal(entries[0]?.etag, 'xyz');
  assert.equal(typeof entries[0]?.mtime, 'number');
});

test('能力探测：条件写 / 范围读 / 删除是否可用由真实请求决定', async () => {
  const dav = await startMockDav();
  const weak = await startMockDavWeak();
  try {
    const backend = createWebDavBackend({ baseUrl: dav.url });
    const capabilities = await backend.probe();
    assert.deepEqual(capabilities, { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false });
    assert.equal(dav.files.size, 0, '探测用的临时文件必须被清理');

    const weakCaps = await createWebDavBackend({ baseUrl: weak.url }).probe();
    assert.equal(weakCaps.conditionalPut, false, '服务端不支持 If-None-Match 时必须如实降级');
    assert.equal(weakCaps.rangeRead, false);
    assert.equal(weakCaps.delete, false);
  } finally {
    await dav.close();
    await weak.close();
  }
});

/** 不支持条件写/范围读/删除的服务端（老 NAS 常见）。 */
async function startMockDavWeak(): Promise<MockDav> {
  return startMockDav({ conditionalPut: false, rangeRead: false, allowDelete: false });
}

test('两个设备通过真实 HTTP（WebDAV）同步并收敛', async () => {
  const dav = await startMockDav();
  try {
    const blindKey = new Uint8Array(32).fill(7);
    const keysA = generateDeviceKeyPair('device-a');
    const keysB = generateDeviceKeyPair('device-b');
    const records: DeviceRecord[] = [
      { deviceId: 'device-a', publicKey: keysA.publicKeyPem, addedAt: 1 },
      { deviceId: 'device-b', publicKey: keysB.publicKeyPem, addedAt: 2 },
    ];
    const roster = new DeviceRosterList(records);
    const engineA = harness(dav.url, 'device-a', keysA, roster, blindKey);
    const engineB = harness(dav.url, 'device-b', keysB, roster, blindKey);
    const stateA = new Materializer();
    const stateB = new Materializer();

    const opA: Op = messageAppend(
      { deviceId: 'device-a', clock: new HlcClock({ now: () => 1_700_000_000_000 }) },
      { sessionId: 'S1', messageId: 'A1', author: 'user', content: '在电脑上写的一句' },
    );
    engineA.enqueue(opA);
    stateA.applyAll([opA]);

    const first = await engineA.sync(stateA);
    assert.deepEqual(first.warnings, []);
    assert.ok(first.uploaded.some((path) => path.startsWith('logs/')));
    assert.ok(first.uploaded.some((path) => path.startsWith('devices/')));

    const second = await engineB.sync(stateB);
    assert.deepEqual(second.warnings, []);
    assert.deepEqual(stateB.orderOf('S1').map((m) => m.id), ['A1']);

    // 反向：B 写的回到 A
    const opB: Op = messageAppend(
      { deviceId: 'device-b', clock: new HlcClock({ now: () => 1_700_000_000_500 }) },
      { sessionId: 'S1', messageId: 'B1', author: 'character', content: '在手机上回的一句' },
    );
    engineB.enqueue(opB);
    stateB.applyAll([opB]);
    await engineB.sync(stateB);
    await engineA.sync(stateA);

    assert.deepEqual(stateA.orderOf('S1').map((m) => m.id), ['A1', 'B1']);
    assert.equal(Materializer.freeze(stateA.snapshot()), Materializer.freeze(stateB.snapshot()));

    // 空转同步应当便宜；且始终只列 devices/（不遍历 logs/）
    engineA.importState(engineA.exportState());
    const idle = await engineA.sync(stateA);
    assert.ok(idle.requests <= 4, `空转同步应 ≤4 次请求，实际 ${idle.requests}`);
    assert.equal(dav.requests.some((line) => line.startsWith('PROPFIND logs')), false, '不得遍历 logs/');
  } finally {
    await dav.close();
  }
});

test('重复写同一路径：服务端服从条件写时返回 exists 而不是覆盖', async () => {
  const dav = await startMockDav();
  try {
    const backend = createWebDavBackend({ baseUrl: dav.url });
    const bytes = new Uint8Array([1, 2, 3]);
    assert.deepEqual(await backend.put('logs/a/00000001-ab.jsonl.gz', bytes, { ifNoneMatch: true }), { ok: true });
    assert.deepEqual(await backend.put('logs/a/00000001-ab.jsonl.gz', bytes, { ifNoneMatch: true }), {
      ok: false,
      exists: true,
    });
    const fetched = await backend.get('logs/a/00000001-ab.jsonl.gz');
    assert.deepEqual([...fetched], [1, 2, 3]);
    assert.ok(backend.delete, 'WebDAV 后端必须提供 delete');
    await backend.delete('logs/a/00000001-ab.jsonl.gz');
    assert.equal(dav.files.size, 0);
  } finally {
    await dav.close();
  }
});
