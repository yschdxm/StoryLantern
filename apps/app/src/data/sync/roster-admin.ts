import { RECOVERY_FILE, parseRecoveryFile } from '../../../../../packages/sync-core/src/recovery.ts';
import type { RosterStampPort, RosterTrust, SyncBackend } from '../../../../../packages/sync-core/src/index.ts';
import type { DeviceStore } from '../op-ports.ts';
import {
  ROSTER_KEY,
  getManagementKey,
  loadRoster,
  loadRosterChecked,
  saveStampedRoster,
  setManagementKey,
} from './roster-store.ts';

/**
 * 名单盖章的**界面侧**编排：看当前信任状态、用恢复密钥给名单盖章。
 *
 * 为什么公钥不用用户手抄：应用早就把恢复密钥的公钥发布到了共享目录（`recovery.json`），
 * 「用恢复密钥接回设备」那条路用的就是它 —— 盖章复用同一个来源，用户只需要粘**私钥**（和接回设备一样）。
 *
 * 说清盖章保护的是什么：它保护的是**本机名单文件**（`sync.roster.v1` 写在设备本地 kv）。
 * 谁改了这份文件（增删设备、改吊销状态），验章都能发现。它**不**覆盖"远端目录里发现了哪些设备"
 * 这件事（那是每次同步现场读的），这一点写在界面的说明里，不夸大。
 */
export interface RosterAdminDeps {
  device: DeviceStore;
  backend(): Promise<SyncBackend>;
  port(): RosterStampPort;
  now(): number;
}

export interface RosterAdminStatus {
  message: string;
  trust: RosterTrust;
  managementKey?: string;
}

export interface RosterAdmin {
  status(): Promise<RosterAdminStatus>;
  stamp(privateKeyHex: string): Promise<{ ok: true; message: string } | { ok: false; error: string }>;
}

/**
 * 界面直接能用的那层：`status()` 只要一句话（`SyncAdmin.roster` 的形状），
 * 这样 `main.tsx` 只加**一行** —— 那个文件贴着 400 行门禁，能少一行是一行。
 */
export function createRosterAdminSurface(deps: RosterAdminDeps): {
  status(): Promise<string>;
  stamp(privateKeyHex: string): Promise<{ ok: true; message: string } | { ok: false; error: string }>;
} {
  const admin = createRosterAdmin(deps);
  return {
    status: async () => (await admin.status()).message,
    stamp: (privateKeyHex: string) => admin.stamp(privateKeyHex),
  };
}

export function createRosterAdmin(deps: RosterAdminDeps): RosterAdmin {
  const describeKey = (key: string | undefined): string =>
    key === undefined ? '' : `（管理密钥 ${key.slice(0, 12)}…）`;

  return {
    async status(): Promise<RosterAdminStatus> {
      const raw = await deps.device.get(ROSTER_KEY);
      const managementKey = await getManagementKey(deps.device);
      if (raw === undefined || raw === '') {
        return {
          message: `本地还没有名单${describeKey(managementKey)}`,
          trust: 'unstamped',
          ...(managementKey === undefined ? {} : { managementKey }),
        };
      }
      const checked = await loadRosterChecked(deps.device, {
        port: deps.port(),
        ...(managementKey === undefined ? {} : { expectedManagementKey: managementKey }),
      });
      return {
        message: `${checked.message}${describeKey(managementKey)}`,
        trust: checked.trust,
        ...(managementKey === undefined ? {} : { managementKey }),
      };
    },

    async stamp(privateKeyHex) {
      if (privateKeyHex.trim() === '') return { ok: false, error: '先粘贴恢复密钥的私钥' };
      // 公钥来源与"用恢复密钥接回设备"完全一致：远端发布的 recovery.json
      let publicKey = '';
      try {
        const bytes = await (await deps.backend()).get(RECOVERY_FILE);
        publicKey = parseRecoveryFile(new TextDecoder().decode(bytes)).publicKey;
      } catch {
        publicKey = '';
      }
      if (publicKey === '') {
        return { ok: false, error: '远端还没有发布恢复公钥：先在已授权的设备上生成并发布恢复密钥' };
      }
      const roster = await loadRoster(deps.device);
      if (roster.list().length === 0) return { ok: false, error: '名单是空的，先同步一次再盖章' };

      await saveStampedRoster(deps.device, roster, {
        port: deps.port(),
        managementPrivateKey: privateKeyHex.trim(),
        managementPublicKey: publicKey,
        at: deps.now(),
      });
      await setManagementKey(deps.device, publicKey);
      return {
        ok: true,
        message: `已给 ${roster.list().length} 台设备的名单盖章；本机从此要求名单必须带章（${publicKey.slice(0, 12)}…）`,
      };
    },
  };
}
