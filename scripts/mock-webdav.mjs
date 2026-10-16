#!/usr/bin/env node
/**
 * 本地"假 NAS"：够用的 WebDAV 服务，用来在开发机上验证同步链路。
 *
 * 支持的方法就是哑存储真正需要的那几个：PROPFIND（列目录）、GET、PUT（含 If-None-Match）、
 * DELETE、MKCOL、HEAD、OPTIONS。数据落在磁盘目录里，因此**可以用文件管理器直接看**——
 * "段名是内容寻址的、每台设备只写自己的命名空间"这些性质一眼就能验证。
 *
 * 用法：
 *   node scripts/mock-webdav.mjs [port] [rootDir]
 *   # 然后在 App 的「设置 → 同步」填 http://10.0.2.2:<port>/（模拟器访问宿主机）
 *   # 需要认证时设环境变量 WEBDAV_USER / WEBDAV_PASSWORD
 */
import http from 'node:http';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] ?? 15197);
const root = path.resolve(process.argv[3] ?? path.join(process.cwd(), '.webdav-out'));
const user = process.env.WEBDAV_USER ?? '';
const password = process.env.WEBDAV_PASSWORD ?? '';
let requests = 0;

/**
 * 可降级开关 —— 用来验证"能力探测与降级"这条路（M6 计划里的一项）。
 *
 * 真实世界的哑存储差异很大：网盘目录常常没有条件写、老 NAS 没有范围读、只读挂载不能删。
 * 光在代码里写"支持降级"不算数，得能把这些档位**真的造出来**跑一遍同步。
 *
 *   node scripts/mock-webdav.mjs 15197 .webdav-out --no-conditional
 *   node scripts/mock-webdav.mjs 15197 .webdav-out --no-range --no-delete
 */
const flags = new Set(process.argv.slice(4));
const noConditional = flags.has('--no-conditional') || process.env.WEBDAV_NO_CONDITIONAL === '1';
const noRange = flags.has('--no-range') || process.env.WEBDAV_NO_RANGE === '1';
const noDelete = flags.has('--no-delete') || process.env.WEBDAV_NO_DELETE === '1';

const xmlEscape = (text) => text.replace(/[<>&'"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[ch]);

/** URL 路径 → 磁盘路径；拒绝任何越界（`..`）访问。 */
function resolve(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const relative = decoded.replace(/^\/+/, '');
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('路径越界');
  return { full, relative };
}

function entryHref(relative, isDir) {
  const suffix = isDir && !relative.endsWith('/') ? '/' : '';
  return `/${relative.split('/').map(encodeURIComponent).join('/')}${suffix}`;
}

async function multistatus(relative) {
  const { full } = resolve('/' + relative);
  const info = await stat(full).catch(() => null);
  const responses = [];

  const push = async (filePath, relPath, isDir) => {
    const fileInfo = await stat(filePath).catch(() => null);
    if (fileInfo === null) return;
    const parts = [
      `    <D:href>${xmlEscape(entryHref(relPath, isDir))}</D:href>`,
      '    <D:propstat>',
      '      <D:prop>',
      isDir ? '        <D:resourcetype><D:collection/></D:resourcetype>' : '        <D:resourcetype/>',
      ...(isDir ? [] : [`        <D:getcontentlength>${fileInfo.size}</D:getcontentlength>`]),
      `        <D:getlastmodified>${fileInfo.mtime.toUTCString()}</D:getlastmodified>`,
      `        <D:getetag>"${fileInfo.size.toString(16)}-${Math.floor(fileInfo.mtimeMs).toString(16)}"</D:getetag>`,
      '      </D:prop>',
      '      <D:status>HTTP/1.1 200 OK</D:status>',
      '    </D:propstat>',
    ];
    responses.push(`  <D:response>\n${parts.join('\n')}\n  </D:response>`);
  };

  if (info === null) return undefined;
  await push(full, relative, info.isDirectory());
  if (info.isDirectory()) {
    for (const name of await readdir(full)) {
      const childRel = `${relative.replace(/\/+$/, '')}/${name}`.replace(/^\/+/, '');
      await push(path.join(full, name), childRel, (await stat(path.join(full, name))).isDirectory());
    }
  }

  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${responses.join('\n')}\n</D:multistatus>\n`;
}

function authorized(request) {
  if (user === '') return true;
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return decoded === `${user}:${password}`;
}

const server = http.createServer((request, response) => {
  requests += 1;
  const method = request.method ?? 'GET';
  const { full, relative } = (() => {
    try {
      return resolve(request.url ?? '/');
    } catch {
      return { full: '', relative: '' };
    }
  })();

  if (full === '') {
    response.writeHead(400).end('bad path');
    return;
  }
  if (!authorized(request)) {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="storylantern"' }).end('unauthorized');
    return;
  }

  const log = (status) => console.log(`[webdav] ${method} /${relative} -> ${status}`);

  void (async () => {
    if (method === 'OPTIONS') {
      response.writeHead(200, { dav: '1,2', allow: 'OPTIONS,PROPFIND,GET,PUT,DELETE,MKCOL,HEAD' }).end();
      log(200);
      return;
    }

    if (method === 'PROPFIND') {
      const xml = await multistatus(relative);
      if (xml === undefined) {
        response.writeHead(404).end('not found');
        log(404);
        return;
      }
      response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' }).end(xml);
      log(207);
      return;
    }

    if (method === 'MKCOL') {
      await mkdir(full, { recursive: true });
      response.writeHead(201).end();
      log(201);
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const bytes = await readFile(full).catch(() => null);
      if (bytes === null) {
        response.writeHead(404).end('not found');
        log(404);
        return;
      }
      // 范围读：`--no-range` 时故意不支持，用来验证"探测到没有范围读"这一档。
      const range = noRange ? null : /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      if (range !== null) {
        const start = Number(range[1]);
        const end = range[2] === '' ? bytes.length - 1 : Math.min(Number(range[2]), bytes.length - 1);
        if (start > end || start >= bytes.length) {
          response.writeHead(416, { 'content-range': `bytes */${bytes.length}` }).end();
          log(416);
          return;
        }
        const slice = bytes.subarray(start, end + 1);
        response.writeHead(206, {
          'content-type': 'application/octet-stream',
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
        });
        response.end(method === 'HEAD' ? undefined : slice);
        log(206);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
      response.end(method === 'HEAD' ? undefined : bytes);
      log(200);
      return;
    }

    if (method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const exists = await stat(full).then(() => true).catch(() => false);
      if (exists && !noConditional && request.headers['if-none-match'] !== undefined) {
        response.writeHead(412).end('precondition failed');
        log(412);
        return;
      }
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
      response.writeHead(exists ? 204 : 201).end();
      log(exists ? 204 : 201);
      return;
    }

    if (method === 'DELETE') {
      if (noDelete) {
        // 真实世界里的只读挂载/不允许删的网盘：必须能"如实拒绝"，而不是假装删掉了
        response.writeHead(403).end('delete disabled');
        log(403);
        return;
      }
      const removed = await rm(full, { force: true }).then(() => true).catch(() => false);
      response.writeHead(removed ? 204 : 404).end();
      log(removed ? 204 : 404);
      return;
    }

    response.writeHead(405).end('method not allowed');
    log(405);
  })().catch((error) => {
    console.error(`[webdav] ${method} /${relative} 失败：${error.message}`);
    if (!response.headersSent) response.writeHead(500).end('server error');
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[webdav] 假 NAS 已启动：http://127.0.0.1:${port}/  (root: ${root})`);
  console.log(`[webdav] 模拟器里填：http://10.0.2.2:${port}/`);
  void mkdir(root, { recursive: true });
});

// 让 Ctrl+C 干净退出，并打印一次统计（用来确认"请求数"是否符合预期）
process.on('SIGINT', () => {
  console.log(`[webdav] 共处理 ${requests} 个请求，退出`);
  server.close(() => process.exit(0));
});
