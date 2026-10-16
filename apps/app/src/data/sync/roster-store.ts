import {
  DeviceRosterList,
  assessRosterTrust,
  parseRoster,
  serializeRoster,
  stampRoster,
  type DeviceRecord,
  type RosterStamp,
  type RosterStampPort,
  type RosterTrust,
} from '../../../../../packages/sync-core/src/index.ts';
import type { DeviceStore } from '../op-ports.ts';

/**
 * 设备名单的本地持久化。
 *
 * 名单决定"谁的内容可信"，也决定 GC 能不能回收（要"所有活跃设备都已并入"）。
 * 之前它是每次同步从远端**临时重建**的，于是**吊销无法生效**——重启就忘。
 * 现在写进设备本地 kv：与远端发现的设备合并，但**本地已吊销的一律保持吊销**。
 */

export const ROSTER_KEY = 'sync.roster.v1';
/**
 * 本机配置的**管理密钥公钥**（十六进制）。配了它，就要求名单必须被这把密钥盖章 ——
 * 这是文档里那句"管理密钥签发；没盖章不认"的落点。
 */
export const ROSTER_MANAGEMENT_KEY = 'sync.roster.management.v1';

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

/**
 * **检查过**地读名单：验管理密钥的章，并把信任结论如实交给调用方。
 *
 * 与 `loadRoster` 的区别就是"配了管理密钥时不许含糊"：
 *  - 本机没配管理密钥 → 行为与旧路径一致（`trust: 'unstamped'`，仍返回名单）；
 *  - 本机配了管理密钥 → 只有 `stamped-verified` 才算可信，其余三种（没盖章 / 章是别的密钥 /
 *    签名验不过）**都不认**：调用方应当拒绝使用这份名单（而不是"当作空名单继续同步"——
 *    那等于让攻击者用一份改过的名单换掉我们的名单）。
 *
 * 旧函数保留原样，所以现有调用点不会因为这个改动而改变行为；调用方按需切过来。
 */
export async function loadRosterChecked(
  device: DeviceStore,
  options: { port: RosterStampPort; expectedManagementKey?: string },
): Promise<{ roster: DeviceRosterList; trust: RosterTrust; message: string; stamp?: RosterStamp }> {
  const raw = await device.get(ROSTER_KEY);
  if (raw === undefined || raw === '') {
    return { roster: new DeviceRosterList(), trust: 'unstamped', message: '本地还没有名单' };
  }
  try {
    const result = await assessRosterTrust({
      text: raw,
      port: options.port,
      ...(options.expectedManagementKey === undefined ? {} : { expectedManagementKey: options.expectedManagementKey }),
    });
    return {
      roster: result.roster,
      trust: result.trust,
      message: result.message,
      ...(result.stamp === undefined ? {} : { stamp: result.stamp }),
    };
  } catch (error) {
    // 文本都解析不了：与旧路径一致，当作"还没有名单"，但把原因带出去
    return {
      roster: new DeviceRosterList(),
      trust: 'bad-signature',
      message: `名单解析失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** 把本机的管理密钥公钥记下来（配了它之后，未盖章的名单就不认了）。 */
export async function setManagementKey(device: DeviceStore, publicKeyHex: string): Promise<void> {
  await device.set(ROSTER_MANAGEMENT_KEY, publicKeyHex);
}

/** 读本机配置的管理密钥公钥（没配返回 undefined）。 */
export async function getManagementKey(device: DeviceStore): Promise<string | undefined> {
  const value = await device.get(ROSTER_MANAGEMENT_KEY);
  return value === undefined || value === '' ? undefined : value;
}

/**
 * 用管理密钥**给名单盖章**并落盘（私钥由调用方提供，不落盘、不留存）。
 * 盖完之后，任何配了同一把管理密钥公钥的设备都要求"必须有章"，改一个字节都验不过。
 */
export async function saveStampedRoster(
  device: DeviceStore,
  roster: DeviceRosterList,
  options: { port: RosterStampPort; managementPrivateKey: string; managementPublicKey: string; at: number },
): Promise<RosterStamp> {
  const stamp = await stampRoster({
    roster,
    managementPrivateKey: options.managementPrivateKey,
    managementPublicKey: options.managementPublicKey,
    port: options.port,
    at: options.at,
  });
  await device.set(ROSTER_KEY, serializeRoster(roster, { stamp }));
  return stamp;
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
    const record: DeviceRecord = { deviceId: entry.deviceId, publicKey: '', addedAt: options.now };
    if (entry.name !== undefined && entry.name !== '') record.name = entry.name;
    merged.add(record);
    added.push(entry.deviceId);
  }

  const self = merged.get(options.selfId);
  if (self === undefined) {
    merged.add({ deviceId: options.selfId, publicKey: '', addedAt: options.now, name: '本机' });
  } else {
    // 本机不能被自己吊销掉：否则下次同步会把自己排除在名单外
    const restored: DeviceRecord = {
      deviceId: self.deviceId,
      publicKey: self.publicKey,
      addedAt: self.addedAt,
      name: self.name ?? '本机',
      // 本机不能被自己吊销
    };
    merged.add(restored);
  }

  return { roster: merged, added };
}

export function describeDevice(
  record: DeviceRecord,
  selfId: string,
): { deviceId: string; name: string; self: boolean; revoked: boolean; banned: boolean; addedAt: number; publicKey: string } {
  return {
    deviceId: record.deviceId,
    name: record.name ?? (record.deviceId === selfId ? '本机' : `设备 ${record.deviceId.slice(-4)}`),
    self: record.deviceId === selfId,
    revoked: record.revokedAt !== undefined,
    banned: record.bannedAt !== undefined,
    addedAt: record.addedAt,
    publicKey: record.publicKey,
  };
}
