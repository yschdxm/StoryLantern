import {
  DeviceRosterList,
  parseRoster,
  serializeRoster,
  type DeviceRecord,
} from '../../../../../packages/sync-core/src/index.ts';
import type { SyncDevice } from '../../screens/screen-props.ts';
import type { DeviceStore } from '../op-ports.ts';

/**
 * 设备名单的本地持久化。
 *
 * 名单决定"谁的内容可信"，也决定 GC 能不能回收（要"所有活跃设备都已并入"）。
 * 之前它是每次同步从远端**临时重建**的，于是**吊销无法生效**——重启就忘。
 * 现在写进设备本地 kv：与远端发现的设备合并，但**本地已吊销的一律保持吊销**。
 *
 * 名单不带签名/盖章：信任根是"共享口令派生的加入证明 + P-256 内容密钥包装"。
 * 读取旧文件时忽略已删除的字段（`publicKey` / `stamp`），不报错。
 */

export const ROSTER_KEY = 'sync.roster.v1';

export async function loadRoster(device: DeviceStore): Promise<DeviceRosterList> {
  const raw = await device.get(ROSTER_KEY);
  if (raw === undefined || raw === '') return new DeviceRosterList();
  try {
    return parseRoster(raw);
  } catch {
    // 名单坏了不阻塞同步：当作"还没有名单"，下次同步会重新发现设备
    return new DeviceRosterList();
  }
}

export async function saveRoster(device: DeviceStore, roster: DeviceRosterList): Promise<void> {
  await device.set(ROSTER_KEY, serializeRoster(roster));
}

/**
 * 合并"本地名单"与"这次在远端发现的设备"。
 *
 * 三条规则：
 *  1. 远端发现的**新**设备登记进来（配对/同步都会经过这里）；
 *  2. 已有的设备记录（包括 `revokedAt`）**原样保留**——不因为"又在远端看到它"就复活；
 *  3. 本机永远在名单里且不被吊销。
 */
export function mergeRoster(
  local: DeviceRosterList,
  discovered: readonly { deviceId: string; name?: string }[],
  options: { selfId: string; now: number },
): { roster: DeviceRosterList; added: string[] } {
  const merged = new DeviceRosterList(local.list());
  const added: string[] = [];

  for (const entry of discovered) {
    if (entry.deviceId === '' || merged.get(entry.deviceId) !== undefined) continue;
    const record: DeviceRecord = { deviceId: entry.deviceId, addedAt: options.now };
    if (entry.name !== undefined && entry.name !== '') record.name = entry.name;
    merged.add(record);
    added.push(entry.deviceId);
  }

  const self = merged.get(options.selfId);
  if (self === undefined) {
    merged.add({ deviceId: options.selfId, addedAt: options.now, name: '本机' });
  } else {
    // 本机不能被自己吊销掉：否则下次同步会把自己排除在名单外
    merged.add({ deviceId: self.deviceId, addedAt: self.addedAt, name: self.name ?? '本机' });
  }

  return { roster: merged, added };
}

export function describeDevice(record: DeviceRecord, selfId: string): SyncDevice {
  return {
    deviceId: record.deviceId,
    name: record.name ?? (record.deviceId === selfId ? '本机' : `设备 ${record.deviceId.slice(-4)}`),
    self: record.deviceId === selfId,
    revoked: record.revokedAt !== undefined,
    banned: record.bannedAt !== undefined,
    addedAt: record.addedAt,
  };
}
