import { openSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * **只用于验证**的 FTP 存储夹具（不是产品后端，不进 bundle）。
 *
 * 为什么需要它：产品里**没有** FTP 后端 —— 计划第 ⑤ 条的结论是"宿主只有通用 HTTP 与受限文件 IO，
 * 没有裸 TCP；FTPS 又要 TLS 而项目零第三方依赖"，所以 FTP 被如实记成"评估后不做"。
 * 这一节是为了**把"真实 FTP 服务端"这一层也验掉**：板子上真跑着 pure-ftpd，
 * 我在板上临时建了一个 chroot 到测试目录的账号（顺手用 `pure-pw userdel` 删掉）。
 *
 * 客户端用 Windows 自带的 `curl`（支持 FTP），口令走 `--netrc-file`：
 * **命令行上不出现任何口令**，也不进仓库。
 *
 * 能力**如实建模**：
 *  - `conditionalPut: false` —— FTP 没有 If-None-Match；
 *  - `rangeRead: false` —— 夹具不用 REST；
 *  - `delete: true` —— 但要用原始命令（`curl -Q "DELE …"`）；
 *  - `listPagination/watch: false`。
 *
 * 实现细节沿用 SFTP 夹具的做法：本沙箱里 Node 的**管道** stdio 不可用，所以都"重定向到临时文件"再读回来。
 */

const HOST = process.env.FTP_HOST ?? 'quarkpi-ca2.local';
const NETRC = process.env.FTP_NETRC;

function makeRunner() {
  const dir = mkdtempSync(join(tmpdir(), 'ftp-harness-'));
  const out = join(dir, 'out.txt');
  return {
    run(args, stdinFile) {
      const fdOut = openSync(out, 'w');
      const fdIn = stdinFile === undefined ? 'ignore' : openSync(stdinFile, 'r');
      const result = spawnSync('curl', ['-sS', '--netrc-file', NETRC, ...args], {
        stdio: [fdIn, fdOut, fdOut],
        timeout: 60_000,
        windowsHide: true,
      });
      return { status: result.status, text: readFileSync(out, 'utf8') };
    },
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 只接受相对路径（与产品后端的边界一致）。 */
function safeRelative(path) {
  if (path.startsWith('/') || path.includes('..')) throw new Error(`不接受的路径：${path}`);
  return path;
}

/** 解析 FTP LIST 的一行：`-rw-r--r-- 1 www www 570 Oct 16 07:50 name`。 */
function parseListLine(line) {
  const match = /^([dl-])[-rwxstST]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+[\d:]+\s+(.+)$/.exec(line.trim());
  if (match === null) return undefined;
  return { kind: match[1] === 'd' ? 'dir' : 'file', size: Number(match[2]), name: match[3] };
}

export function createFtpHarnessBackend(options) {
  if (NETRC === undefined) throw new Error('需要 FTP_NETRC 指向一个 netrc 文件（口令不写在命令行上）');
  const root = (options?.root ?? '').replace(/^\/+|\/+$/g, '');
  const runner = makeRunner();
  const urlOf = (path) => `ftp://${HOST}/${root === '' ? '' : root + '/'}${path}`;
  const dirUrlOf = (path) => {
    const clean = path.replace(/^\/+|\/+$/g, '');
    return `ftp://${HOST}/${root === '' ? '' : root + '/'}${clean}`;
  };
  const remotePathOf = (relative) => `/${root === '' ? '' : root + '/'}${safeRelative(relative)}`;

  /**
   * **FTP 不会替你建目录** —— 这是真服务端才暴露的差异：WebDAV 有 `create_full_put_path`、
   * 文件夹后端有 `mkdir -p`，而裸 FTP 往 `logs/peer-a/<会话>/<序号>-<哈希>` 写之前，
   * 每一层都得自己 `MKD`。第一版没做这一步，结果所有上传 550、远端一个文件都没有
   * （引擎只在告警里说"上传失败"，聚合统计上是 0 份快照）。
   */
  const createdDirs = new Set();
  const ensureDirs = (relative) => {
    const parts = safeRelative(relative).split('/').slice(0, -1);
    let acc = '';
    for (const part of parts) {
      acc = acc === '' ? part : `${acc}/${part}`;
      if (createdDirs.has(acc)) continue; // 每次 curl 都要重新登录 FTP，能省则省（真机上一条 PUT 要 1~2 秒）
      // 已存在时 MKD 会返回 550，这不是错误，忽略即可
      runner.run(['-Q', `MKD ${remotePathOf(acc)}`, `ftp://${HOST}/`]);
      createdDirs.add(acc);
    }
  };

  const backend = {
    id: `ftp-harness:${HOST}/${root}`,
    capabilities: {
      conditionalPut: false,
      rangeRead: false,
      delete: true,
      listPagination: false,
      watch: false,
    },

    /** 递归列目录（FTP 的 LIST 是逐目录的，没有 Depth: infinity 那种东西）。 */
    async list(prefix) {
      const entries = [];
      const walk = async (relative) => {
        const listing = runner.run([`${dirUrlOf(relative)}/`]);
        if (listing.status !== 0) return;
        for (const line of listing.text.split('\n')) {
          const parsed = parseListLine(line);
          if (parsed === undefined) continue;
          // FTP 的 LIST 永远会带上 `.` 与 `..`，不跳过就是**无限递归**（第一版就卡在这里：
          // 只写了两个文件就再没动静，因为每层都在重新列同一个目录）。
          if (parsed.name === '.' || parsed.name === '..') continue;
          const child = relative === '' ? parsed.name : `${relative}/${parsed.name}`;
          if (parsed.kind === 'dir') await walk(child);
          else entries.push({ path: child, size: parsed.size });
        }
      };
      const start = prefix.replace(/^\/+|\/+$/g, '');
      await walk(start === '' ? '' : start);
      return { entries };
    },

    async get(path) {
      const target = join(runner.dir, `get-${Math.random().toString(36).slice(2, 8)}.bin`);
      const result = runner.run(['-o', target, urlOf(safeRelative(path))]);
      if (result.status !== 0) throw new Error(`FTP GET ${path} 失败：${result.text.slice(0, 120)}`);
      return new Uint8Array(readFileSync(target));
    },

    async put(path, bytes, putOptions) {
      // 如实：FTP 不认 If-None-Match，故意忽略它（这就是 conditionalPut: false 的含义）
      void putOptions;
      const source = join(runner.dir, `put-${Math.random().toString(36).slice(2, 8)}.bin`);
      writeFileSync(source, bytes);
      ensureDirs(path);
      const result = runner.run(['-T', source, urlOf(safeRelative(path))]);
      return result.status === 0 ? { ok: true } : { ok: false };
    },

    async delete(path) {
      // FTP 的删除要发原始命令：DELE。路径必须与 put/get **完全同形**（都带 root 前缀），
      // 否则会删到别处 —— 第一版就是这里写成 `DELE /<path>` 而 PUT 用的是 `/root/<path>`，于是 550。
      const result = runner.run(['-Q', `DELE /${root === '' ? '' : root + '/'}${safeRelative(path)}`, `ftp://${HOST}/`]);
      if (result.status !== 0) throw new Error(`FTP DELETE ${path} 失败：${result.text.slice(0, 120)}`);
    },

    /** 能力探测：条件写**真的探一遍**（两次带 If-None-Match 的写），结果如实。 */
    async probe() {
      const probePath = `.probe-${Math.random().toString(36).slice(2, 10)}.txt`;
      const payload = new Uint8Array([1, 2, 3]);
      const first = await backend.put(probePath, payload, { ifNoneMatch: true });
      const second = await backend.put(probePath, payload, { ifNoneMatch: true });
      const conditionalPut = first.ok === true && second.exists === true;
      await backend.delete(probePath);
      return { conditionalPut, rangeRead: false, delete: true, listPagination: false, watch: false };
    },

    dispose() {
      runner.cleanup();
    },
  };

  return backend;
}
