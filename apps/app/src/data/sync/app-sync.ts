import type { SyncBackend } from '../../../../../packages/sync-core/src/backend.ts';
import { emptyState, type LocalSyncState } from '../../../../../packages/sync-core/src/state.ts';
import type { DeviceStore } from '../op-ports.ts';
import type { OpLogRepository } from '../op-repository.ts';
import type { SettingsStore } from '../repository.ts';
import type { SettingsMap } from '../types.ts';
import { SETTING_KEYS } from '../types.ts';
import { createSyncService, syncAvailable, type SyncStorePort, type SyncSummary } from './service.ts';

/**
 * 把同步接到应用上：**非机密配置**从设置读，**同步口令与进度**放设备本地 kv。
 *
 * 为什么要分开：
 *  - 宿主对含 `api_key` / `token` / `secret` 的设置键只回掩码（这是对的，
 *    模型密钥就不该到界面），但同步口令必须由应用读回明文来派生密钥——
 *    放在被掩码的键上会出现"界面显示 `••••••`，写回去把真口令覆盖掉"的事故（真机踩过）；
 *  - 后端从**插件注册表**拿，而不是直接 import：关掉一行 bundle patch，功能就真的消失。
 */

export interface SyncConfig {
  kind: 'off' | 'webdav' | 'folder';
  url: string;
  username: string;
  password: string;
  /** 本地文件夹同步的根目录；留空 = 宿主默认（应用私有目录下的 sync/）。 */
  folder: string;
  secret: string;
}

/** 插件注册的后端工厂形状（`ctx.set('sync.backend.webdav', …)`）。 */
export interface SyncBackendFactory {
  kind: string;
  create(options: { baseUrl: string; username?: string; password?: string; fetch?: typeof fetch }): SyncBackend;
}

/** 本地文件夹后端：由宿主提供文件读写，因此这里注入而不是从插件注册表拿。 */
export interface FolderBackendProvider {
  backend: SyncBackend;
  /** 设置（并创建）根目录，返回最终解析出来的绝对路径。 */
  setRoot(path: string): Promise<string>;
}

/** 设备本地 kv 里用到的键。 */
export const SYNC_SECRET_KEY = 'sync.secret.v1';
export const SYNC_STATE_KEY = 'sync.state.v1';
/** 每个远端各存一份进度：换了远端（WebDAV ↔ 文件夹、或换个地址）不能接着用旧的段清单。 */
export const SYNC_STATE_PREFIX = 'sync.state.v2:';
/** 设备级的清单序号：对端用它判断"存储是否被还原"，所以换远端也必须继续递增。 */
export const SYNC_MANIFEST_SEQ_KEY = 'sync.manifestSeq.v1';

/**
 * 远端的身份：进度就是按它分桶的。
 *
 * 为什么必须分桶：`hosted`（我发布了哪些段）是**针对某个远端**的事实。
 * 换了远端还接着用旧清单，就会发一份"引用了不存在段"的清单出去——
 * 真机上实测过：对端每次同步都报"缺少第 N 号段"。
 */
export function remoteIdOf(config: SyncConfig, resolvedRoot?: string): string {
  return config.kind === 'folder' ? `folder:${(resolvedRoot ?? config.folder).trim()}` : `webdav:${config.url.trim()}`;
}

/** 设置 + 设备本地 kv → 一次同步需要的配置（口令在 kv 里，见上）。 */
export async function readSyncConfig(settings: SettingsMap, device: DeviceStore): Promise<SyncConfig> {
  const raw = settings[SETTING_KEYS.syncKind];
  const kind = raw === 'webdav' || raw === 'folder' ? raw : 'off';
  return {
    kind,
    url: settings[SETTING_KEYS.syncUrl] ?? '',
    username: settings[SETTING_KEYS.syncUsername] ?? '',
    password: settings[SETTING_KEYS.syncPassword] ?? '',
    folder: settings[SETTING_KEYS.syncFolder] ?? '',
    secret: (await device.get(SYNC_SECRET_KEY)) ?? '',
  };
}

function parseState(raw: string | undefined): { state?: LocalSyncState; enqueuedSeq: number } | undefined {
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed = JSON.parse(raw) as { state?: LocalSyncState; enqueuedSeq?: number };
    return {
      ...(parsed.state === undefined ? {} : { state: parsed.state }),
      enqueuedSeq: typeof parsed.enqueuedSeq === 'number' ? parsed.enqueuedSeq : 0,
    };
  } catch {
    // 坏进度只意味着"下次多推一点"，不该让同步彻底失败
    return undefined;
  }
}

/**
 * 同步进度（引擎状态 + 推送游标）按**远端**存在设备本地：它不是共享内容，也不进 op 日志。
 *
 * 第一次面对某个远端时：内容进度从零（会把本地 op 重推一遍，段名内容寻址所以不会写坏），
 * 但**清单序号沿用设备级计数**——否则对端看到序号变小，会按"存储疑似被还原"直接忽略我们。
 */
export function deviceSyncStore(device: DeviceStore, remoteId: string): SyncStorePort {
  const key = `${SYNC_STATE_PREFIX}${remoteId}`;

  const knownManifestSeq = async (): Promise<number> => {
    const stored = Number((await device.get(SYNC_MANIFEST_SEQ_KEY)) ?? '0');
    const legacy = parseState(await device.get(SYNC_STATE_KEY))?.state?.manifestSeq ?? 0;
    return Math.max(Number.isFinite(stored) ? stored : 0, legacy, 1);
  };

  return {
    async load() {
      const own = parseState(await device.get(key));
      if (own !== undefined) return own;
      // 旧版本只有一个全局进度键：把它当作 WebDAV 那个远端的历史（当时只有 WebDAV）
      if (remoteId.startsWith('webdav:')) {
        const legacy = parseState(await device.get(SYNC_STATE_KEY));
        if (legacy !== undefined) return legacy;
      }
      const fresh = emptyState();
      return { state: { ...fresh, manifestSeq: await knownManifestSeq() }, enqueuedSeq: 0 };
    },
    async save(input) {
      await device.set(key, JSON.stringify(input));
      const used = input.state.manifestSeq;
      if (used > (Number((await device.get(SYNC_MANIFEST_SEQ_KEY)) ?? '0') || 0)) {
        await device.set(SYNC_MANIFEST_SEQ_KEY, String(used));
      }
    },
  };
}

export function describeSyncProblem(config: SyncConfig, available: boolean): string | undefined {
  if (config.kind === 'off') return undefined;
  if (!available) return '这个环境没有 WebCrypto，无法加密同步数据';
  if (config.kind === 'webdav' && config.url.trim() === '') return '还没有填远端地址';
  if (config.secret.trim() === '') return '还没有填同步口令（两台设备要一致）';
  return undefined;
}

export interface RunSyncInput {
  repository: OpLogRepository;
  settings: SettingsStore;
  device: DeviceStore;
  /** 已解析的配置（口令已从设备 kv 读出来）。 */
  config: SyncConfig;
  backendFactory: SyncBackendFactory | undefined;
  /** 本地文件夹后端（宿主提供文件读写）；没配置好时为 undefined。 */
  folderBackend?: FolderBackendProvider | undefined;
  /** 走宿主的 fetch：WebView 里跨源会被 CORS 拦，所以同步请求必须由宿主发出。 */
  hostFetch?: typeof fetch;
  now?: () => number;
}

export interface RunSyncOutcome extends SyncSummary {
  /** 本地文件夹同步时，宿主解析出来的根目录（给界面显示）。 */
  root?: string;
}

export async function runSync(input: RunSyncInput): Promise<RunSyncOutcome> {
  const problem = describeSyncProblem(input.config, syncAvailable());
  if (problem !== undefined) throw new Error(problem);

  let backend: SyncBackend;
  let root: string | undefined;

  if (input.config.kind === 'folder') {
    if (input.folderBackend === undefined) throw new Error('本地文件夹同步需要宿主支持（Tauri 壳里才有）');
    root = await input.folderBackend.setRoot(input.config.folder);
    backend = input.folderBackend.backend;
  } else {
    if (input.backendFactory === undefined) throw new Error('同步后端未启用（检查 bundle patch 里是否关掉了这一行）');
    backend = input.backendFactory.create({
      baseUrl: input.config.url,
      ...(input.config.username === '' ? {} : { username: input.config.username }),
      ...(input.config.password === '' ? {} : { password: input.config.password }),
      ...(input.hostFetch === undefined ? {} : { fetch: input.hostFetch }),
    });
  }

  const service = await createSyncService({
    repository: input.repository,
    backend,
    deviceId: await deviceIdOf(input.settings),
    secret: input.config.secret,
    store: deviceSyncStore(input.device, remoteIdOf(input.config, root)),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const summary = await service.sync();
  return root === undefined ? summary : { ...summary, root };
}

/** 同步用的设备 id 与 op 里的 deviceId 是同一个：先由 op-ports 的解析器生成过。 */
async function deviceIdOf(settings: SettingsStore): Promise<string> {
  const existing = await settings.get('device.id');
  return existing ?? 'unknown-device';
}
