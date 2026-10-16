/**
 * "第二台设备"：用同一份链路（op 日志 + 同步引擎 + WebCrypto）连真实的 WebDAV 后端。
 *
 * 用途有两个：
 *  1. 开发期验证跨端收敛——App（设备 A）推上去的东西，这里能不能读出来；
 *     这里写的东西，App 能不能拉回去；
 *  2. 给用户一个排查工具：换机没同步上时，跑一下就知道远端到底有什么。
 *
 * 用法：
 *   node eval/sync/dev-peer.ts <url> <secret> [--device <id>] [--say <文本>] [--user u --pass p]
 *
 * 例：
 *   node eval/sync/dev-peer.ts http://127.0.0.1:15197/ my-passphrase --say "从命令行说一句"
 */
import { createLocalOpPorts } from '../../apps/app/src/data/op-ports.ts';
import { createMemoryKeyValue } from '../../apps/app/src/data/local-repository.ts';
import { createOpLogRepository, type OpLogRepository } from '../../apps/app/src/data/op-repository.ts';
import { deviceSyncStore, type SyncBackendFactory } from '../../apps/app/src/data/sync/app-sync.ts';
import { createFolderBackend, type FilePort } from '../../apps/app/src/data/sync/folder-backend.ts';
import { createSyncService } from '../../apps/app/src/data/sync/service.ts';
import { createWebDavBackend } from '../../plugins/sync-webdav/src/index.ts';
import type { SyncBackend } from '../../packages/sync-core/src/backend.ts';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 本地文件夹的文件端口（Node 版）。
 *
 * 工具侧直接用 fs：这里的 `root` 由使用者给出，且只在开发机上跑。
 * 应用里那份走宿主的 `files.*`（见文件夹后端的实现与 DEVELOPMENT.md）。
 */
function createNodeFiles(root: string): FilePort {
  const resolve = (relative: string): string => {
    const full = path.resolve(root, relative);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`路径越界：${relative}`);
    return full;
  };

  const walk = async (dir: string, out: string[]): Promise<void> => {
    for (const name of await readdir(dir).catch(() => [])) {
      const full = path.join(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full, out);
      else out.push(full);
    }
  };

  return {
    async list(prefix) {
      const files: string[] = [];
      await walk(prefix === '' ? root : resolve(prefix.replace(/\/+$/, '')), files);
      return Promise.all(
        files.map(async (full) => {
          const info = await stat(full);
          return { path: path.relative(root, full).replace(/\\/g, '/'), size: info.size, mtime: info.mtimeMs };
        }),
      );
    },
    read: (relative) => readFile(resolve(relative)),
    async write(relative, bytes, options) {
      const full = resolve(relative);
      const exists = await stat(full).then(() => true).catch(() => false);
      if (exists && options?.ifNoneMatch === true) return { ok: true, exists: true };
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, bytes);
      return { ok: true, exists };
    },
    async delete(relative) {
      await rm(resolve(relative), { force: true });
    },
  };
}

interface Args {
  url: string;
  secret: string;
  device: string;
  say?: string;
  user?: string;
  pass?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const [url, secret] = argv;
  if (url === undefined || secret === undefined) {
    console.error('用法：node eval/sync/dev-peer.ts <url> <secret> [--device id] [--say 文本] [--user u --pass p]');
    process.exit(1);
  }
  const rest = argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const index = rest.indexOf(flag);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  const out: Args = { url: url ?? '', secret: secret ?? '', device: valueOf('--device') ?? 'dev-peer' };
  const say = valueOf('--say');
  if (say !== undefined) out.say = say;
  const user = valueOf('--user');
  if (user !== undefined) out.user = user;
  const pass = valueOf('--pass');
  if (pass !== undefined) out.pass = pass;
  return out;
}

async function describe(repository: OpLogRepository): Promise<void> {
  const characters = await repository.characters.list();
  const sessions = await repository.sessions.list();
  console.log(`  角色 ${characters.length}：${characters.map((item) => item.name).join('、') || '（无）'}`);
  console.log(`  会话 ${sessions.length}：`);
  for (const session of sessions) {
    const messages = await repository.messages.list(session.id);
    console.log(`    · ${session.title}（角色 ${session.characterName || '—'}，${messages.length} 条）`);
    for (const message of messages.slice(-2)) {
      console.log(`        ${message.role === 'user' ? '用户' : '角色'}：${message.content.slice(0, 40)}`);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const ports = createLocalOpPorts(createMemoryKeyValue());
const repository = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: args.device });
await repository.ready;

// 远端可以是 WebDAV，也可以是本地文件夹（`file:///path` 或直接给目录路径）。
// 后者让"文件夹同步"也能用这个工具验证：App 写到某个目录，这里读同一个目录。
let backend: SyncBackend;
if (args.url.startsWith('file://') || !/^https?:\/\//i.test(args.url)) {
  // `file:///F:/x` 这种 URL 要用 fileURLToPath 还原，否则 Windows 上会拼成 `F:\F:\x`
  const root = args.url.startsWith('file://') ? fileURLToPath(args.url) : path.resolve(args.url);
  await mkdir(root, { recursive: true });
  backend = createFolderBackend(createNodeFiles(root));
  console.log(`[peer] 远端＝本地文件夹 ${root}`);
} else {
  const factory: SyncBackendFactory = { kind: 'webdav', create: (options) => createWebDavBackend(options) };
  backend = factory.create({
    baseUrl: args.url,
    ...(args.user === undefined ? {} : { username: args.user }),
    ...(args.pass === undefined ? {} : { password: args.pass }),
  });
}

const service = await createSyncService({
  repository,
  backend,
  deviceId: args.device,
  secret: args.secret,
  store: deviceSyncStore(ports.device, `peer:${args.url}`),
});

console.log(`[peer] 设备 ${args.device} → ${args.url}`);
const first = await service.sync();
console.log(`[peer] 第 1 次同步：上传 ${first.uploaded} 段 / 下载 ${first.downloaded} 段 / 并入 ${first.appliedOps} 条变更`);
if (first.warnings.length > 0) for (const warning of first.warnings) console.log(`  ⚠ ${warning}`);

console.log('[peer] 远端读到的内容：');
await describe(repository);

if (args.say !== undefined) {
  const session = (await repository.sessions.list())[0];
  if (session === undefined) {
    console.log('[peer] 远端还没有会话，无法 --say；先让 App 建一个再试');
  } else {
    await repository.messages.append(session.id, 'user', args.say);
    const second = await service.sync();
    console.log(`[peer] 写入「${args.say}」并同步：上传 ${second.uploaded} 段`);
  }
}

const stats = await repository.logStats();
console.log(`[peer] 本地日志 ${stats.count} 条 · 隔离 ${stats.corrupt} 条`);
