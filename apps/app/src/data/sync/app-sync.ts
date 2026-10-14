import type { SyncBackend } from '../../../../../packages/sync-core/src/backend.ts';
import type { LocalSyncState } from '../../../../../packages/sync-core/src/state.ts';
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
  kind: 'off' | 'webdav';
  url: string;
  username: string;
  password: string;
  secret: string;
}

/** 插件注册的后端工厂形状（`ctx.set('sync.backend.webdav', …)`）。 */
export interface SyncBackendFactory {
  kind: string;
  create(options: { baseUrl: string; username?: string; password?: string; fetch?: typeof fetch }): SyncBackend;
}

/** 设备本地 kv 里用到的键。 */
export const SYNC_SECRET_KEY = 'sync.secret.v1';
export const SYNC_STATE_KEY = 'sync.state.v1';

export async function readSyncConfig(settings: SettingsMap, device: DeviceStore): Promise<SyncConfig> {
  const kind = settings[SETTING_KEYS.syncKind] === 'webdav' ? 'webdav' : 'off';
  return {
    kind,
    url: settings[SETTING_KEYS.syncUrl] ?? '',
    username: settings[SETTING_KEYS.syncUsername] ?? '',
    password: settings[SETTING_KEYS.syncPassword] ?? '',
    secret: (await device.get(SYNC_SECRET_KEY)) ?? '',
  };
}

/** 同步进度（引擎状态 + 推送游标）也放设备本地：它不是共享内容，不该进 op 日志。 */
export function deviceSyncStore(device: DeviceStore): SyncStorePort {
  return {
    async load() {
      const raw = await device.get(SYNC_STATE_KEY);
      if (raw === undefined || raw === '') return { enqueuedSeq: 0 };
      try {
        const parsed = JSON.parse(raw) as { state?: LocalSyncState; enqueuedSeq?: number };
        return {
          ...(parsed.state === undefined ? {} : { state: parsed.state }),
          enqueuedSeq: typeof parsed.enqueuedSeq === 'number' ? parsed.enqueuedSeq : 0,
        };
      } catch {
        // 坏进度只意味着"下次多推一点"，不该让同步彻底失败
        return { enqueuedSeq: 0 };
      }
    },
    async save(input) {
      await device.set(SYNC_STATE_KEY, JSON.stringify(input));
    },
  };
}

export function describeSyncProblem(config: SyncConfig, available: boolean): string | undefined {
  if (config.kind === 'off') return undefined;
  if (!available) return '这个环境没有 WebCrypto，无法加密同步数据';
  if (config.url.trim() === '') return '还没有填远端地址';
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
  /** 走宿主的 fetch：WebView 里跨源会被 CORS 拦，所以同步请求必须由宿主发出。 */
  hostFetch?: typeof fetch;
  now?: () => number;
}

export async function runSync(input: RunSyncInput): Promise<SyncSummary> {
  const problem = describeSyncProblem(input.config, syncAvailable());
  if (problem !== undefined) throw new Error(problem);
  if (input.backendFactory === undefined) throw new Error('同步后端未启用（检查 bundle patch 里是否关掉了这一行）');

  const backend = input.backendFactory.create({
    baseUrl: input.config.url,
    ...(input.config.username === '' ? {} : { username: input.config.username }),
    ...(input.config.password === '' ? {} : { password: input.config.password }),
    ...(input.hostFetch === undefined ? {} : { fetch: input.hostFetch }),
  });
  const service = await createSyncService({
    repository: input.repository,
    backend,
    deviceId: await deviceIdOf(input.settings),
    secret: input.config.secret,
    store: deviceSyncStore(input.device),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return service.sync();
}

/** 同步用的设备 id 与 op 里的 deviceId 是同一个：先由 op-ports 的解析器生成过。 */
async function deviceIdOf(settings: SettingsStore): Promise<string> {
  const existing = await settings.get('device.id');
  return existing ?? 'unknown-device';
}
