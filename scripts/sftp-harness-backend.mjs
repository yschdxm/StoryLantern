import { openSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * **只用于验证**的 SFTP 存储夹具（不是产品后端，不进 bundle）。
 *
 * 为什么要有它：计划里 M6 的退出判据写着"真实 NAS 实测"。这台开发板是真 NAS（Samba + pure-ftpd + 大磁盘），
 * 但匿名 FTP 被拒（实测 530）、Samba 只导出了只读的 [homes]（没有可写的自定义共享），
 * 而用户给的是 **SSH 密钥** —— 于是"真实第三方存储"这一层用 SFTP 走通最顺，且不动板子上的任何配置。
 *
 * 能力**如实建模**（不为了让测试好看而假装）：
 *  - `conditionalPut: false` —— 裸 SFTP 没有 If-None-Match 这种东西。这正好是一个真实的降级档：
 *    同步协议在"不认条件写"的存储上仍然要收敛（靠内容寻址 + 每台设备只写自己命名空间）；
 *  - `rangeRead: false`、`listPagination: false`、`watch: false`；
 *  - `delete: true`（sftp 能删）。
 *
 * 实现细节：本沙箱里 Node 的**管道** stdio 不可用，所以每次调用都"重定向到临时文件"再读回来
 * （探针已验证可行）。这是夹具的实现细节，与产品无关。
 *
 * 类型标注一律不写（这是 `.mjs`）：字段含义见注释。
 */

const SSH = 'ssh';
const DEFAULT_HOST = '开发板';

/** 跑一条远端命令并把 stdout/stderr 收进临时文件（不走管道）。 */
function makeRunner(host, timeoutMs) {
  const dir = mkdtempSync(join(tmpdir(), 'sftp-harness-'));
  const out = join(dir, 'out.txt');
  return {
    run(args, stdinFile) {
      const fdOut = openSync(out, 'w');
      const fdIn = stdinFile === undefined ? 'ignore' : openSync(stdinFile, 'r');
      const result = spawnSync(
        SSH,
        ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`, host, ...args],
        { stdio: [fdIn, fdOut, fdOut], timeout: timeoutMs, windowsHide: true },
      );
      const text = readFileSync(out, 'utf8');
      return { status: result.status, text, errorCode: result.error?.code };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 只接受我们自己拼出来的相对路径：拒绝绝对路径与 `..`（与产品后端的边界一致）。 */
function safeRelative(path) {
  if (path.startsWith('/') || path.includes('..')) throw new Error(`不接受的路径：${path}`);
  return path;
}

function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function createSftpHarnessBackend(options) {
  const host = options.host ?? DEFAULT_HOST;
  const root = options.root.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const runner = makeRunner(host, timeoutMs);

  const fileOf = (path) => `${root}/${safeRelative(path)}`;

  const backend = {
    id: `sftp-harness:${host}:${root}`,
    capabilities: {
      conditionalPut: false,
      rangeRead: false,
      delete: true,
      listPagination: false,
      watch: false,
    },

    async list(prefix) {
      const base = `${root}/${prefix === '' ? '' : safeRelative(prefix).replace(/\/+$/, '')}`;
      // 这条板子是 GNU find（`-printf` 可用）；查不到就当空目录 —— 与"前缀还不存在"同义
      const result = runner.run([`find ${shellQuote(base)} -type f -printf '%s\\t%p\\n' 2>/dev/null || true`]);
      const entries = result.text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const tab = line.indexOf('\t');
          const size = Number(line.slice(0, tab));
          const full = line.slice(tab + 1);
          const path = full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full;
          return { path, size: Number.isFinite(size) ? size : 0 };
        });
      return { entries };
    },

    async get(path) {
      const result = runner.run([`base64 -w0 ${shellQuote(fileOf(path))}`]);
      if (result.status !== 0 || result.text.trim() === '') {
        throw new Error(`SFTP GET ${path} 失败：${result.status ?? result.errorCode ?? '?'}`);
      }
      return new Uint8Array(Buffer.from(result.text.trim(), 'base64'));
    },

    async put(path, bytes, putOptions) {
      // 如实：裸 SFTP 不认 If-None-Match，所以这里**故意忽略**它（这就是 conditionalPut: false 的含义）。
      // 内容是端到端加密的密文、段名是内容寻址的 —— 同名即同内容，被覆盖不会写坏任何东西。
      void putOptions;
      const dir = mkdtempSync(join(tmpdir(), 'sftp-put-'));
      const payload = join(dir, 'payload.bin');
      writeFileSync(payload, bytes);
      try {
        const target = fileOf(path);
        const result = runner.run([`mkdir -p "$(dirname ${shellQuote(target)})" && cat > ${shellQuote(target)}`], payload);
        return result.status === 0 ? { ok: true } : { ok: false };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },

    async delete(path) {
      const result = runner.run([`rm -f ${shellQuote(fileOf(path))}`]);
      if (result.status !== 0) throw new Error(`SFTP DELETE ${path} 失败：${result.status}`);
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

    /** 夹具用：跑一条任意命令（建目录、清理、看板子信息）。 */
    exec(command) {
      const result = runner.run([command]);
      if (result.status !== 0) throw new Error(`远端命令失败（${result.status}）：${result.text.slice(0, 200)}`);
      return result.text;
    },

    dispose() {
      runner.cleanup();
    },
  };

  return backend;
}
