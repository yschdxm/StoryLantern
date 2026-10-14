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
import { createSyncService } from '../../apps/app/src/data/sync/service.ts';
import { createWebDavBackend } from '../../plugins/sync-webdav/src/index.ts';

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

const factory: SyncBackendFactory = { kind: 'webdav', create: (options) => createWebDavBackend(options) };
const backend = factory.create({
  baseUrl: args.url,
  ...(args.user === undefined ? {} : { username: args.user }),
  ...(args.pass === undefined ? {} : { password: args.pass }),
});

const service = await createSyncService({
  repository,
  backend,
  deviceId: args.device,
  secret: args.secret,
  store: deviceSyncStore(ports.device),
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
