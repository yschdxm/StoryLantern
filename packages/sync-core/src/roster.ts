/**
 * 设备名单与 GC 判定。
 *
 * 为什么需要名单：GC 天然需要一个"所有人都已同步"的判据。哑存储无法提供，
 * 只能在客户端维护一份显式名单——配对即登记、退役必须显式操作（UI 要警告
 * "它离线期间的新数据将不再保留"）。没有名单就只能永不回收，空间无上界。
 */

import { utf8 } from '../../oplog/src/bytes.ts';

export interface DeviceRecord {
  deviceId: string;
  publicKey: string;
  name?: string;
  addedAt: number;
  revokedAt?: number;
  /**
   * **永久禁用（黑名单）**的时间。
   *
   * 与 `revokedAt` 的区别（已定的设计）：
   *  - `revokedAt`＝临时踢出：从活跃名单里划掉；它下次**输密码还能重新连进来**；
   *  - `bannedAt`＝永久禁用：**拒绝它的签名**，加入请求也不认——它知道门码也没用。
   *
   * 要它"连新内容也读不到"，两者都要配合**换代**（新数据钥匙只包给留下的设备）；
   * 已经在它手里的旧内容收不回，这条写进文档，不假装能做到。
   */
  bannedAt?: number;
}

export class DeviceRosterList {
  readonly #devices = new Map<string, DeviceRecord>();

  constructor(records: readonly DeviceRecord[] = []) {
    for (const record of records) this.#devices.set(record.deviceId, { ...record });
  }

  add(record: DeviceRecord): void {
    this.#devices.set(record.deviceId, { ...record });
  }

  revoke(deviceId: string, at: number = Date.now()): boolean {
    const record = this.#devices.get(deviceId);
    if (!record || record.revokedAt !== undefined) return false;
    record.revokedAt = at;
    return true;
  }

  get(deviceId: string): DeviceRecord | undefined {
    return this.#devices.get(deviceId);
  }

  list(): DeviceRecord[] {
    return [...this.#devices.values()];
  }

  active(): DeviceRecord[] {
    // 被永久禁用的不算活跃：GC"所有活跃设备都已并入"的判定不能把它算进去
    return this.list().filter((record) => record.revokedAt === undefined && record.bannedAt === undefined);
  }

  /**
   * 永久禁用（黑名单）。**不能禁用本机自己**：否则下次同步会把自己排除在外。
   *
   * 返回是否真的写进去了（幂等：已经禁过就返回 false）。
   */
  ban(deviceId: string, at: number): boolean {
    const record = this.#devices.get(deviceId);
    if (!record || record.bannedAt !== undefined) return false;
    record.bannedAt = at;
    return true;
  }

  unban(deviceId: string): boolean {
    const record = this.#devices.get(deviceId);
    if (!record || record.bannedAt === undefined) return false;
    delete record.bannedAt;
    return true;
  }

  isBanned(deviceId: string): boolean {
    return this.#devices.get(deviceId)?.bannedAt !== undefined;
  }

  /** 黑名单（永久禁用的设备 id）：加入请求校验要用它。 */
  bannedIds(): string[] {
    return this.list()
      .filter((record) => record.bannedAt !== undefined)
      .map((record) => record.deviceId);
  }

  activeIds(): string[] {
    return this.active().map((record) => record.deviceId);
  }

  /** deviceId -> 公钥 PEM，直接喂给验签器。没有公钥的设备（共享口令模式）不参与验签。 */
  toVerifierMap(): Map<string, string> {
    return new Map(
      this.active()
        .filter((record) => record.publicKey !== '')
        .map((record) => [record.deviceId, record.publicKey]),
    );
  }
}

export interface AckSource {
  deviceId: string;
  /** 该设备声明"我已并入 deviceId 的第几号段"。 */
  ack: Record<string, number>;
}

export interface PersistedRoster {
  v: 1;
  devices: DeviceRecord[];
  /** 管理密钥的盖章（可选：没盖章的名单仍能读，但**配了管理密钥的机器不认**，见 `assessRosterTrust`）。 */
  stamp?: RosterStamp;
}

/**
 * 名单盖章：用**管理密钥**（就是那把离线保存的恢复密钥）给名单主体签名。
 *
 * 为什么需要它（这是文档里记了很久的欠账）：在此之前信任模型是"名单优先于签名"——
 * 能防伪造**内容**，但防不了"名单本身被谁改过"。盖章之后，改一个字节都验不过。
 *
 * 签名覆盖的是 `rosterPayload(devices)`（排序 + 固定字段的规范字节），
 * 与设备签名那套分开：这是**管理身份**，不是某台设备。
 */
export interface RosterStamp {
  v: 1;
  /** 盖章用的公钥（十六进制）。公开：验章的人据此判断"这是不是我们那把管理密钥"。 */
  managementPublicKey: string;
  /** 覆盖 `rosterPayload(devices)` 的签名（十六进制）。 */
  signature: string;
  at: number;
}

/** 与 `RecoveryProofPort` 同形（app 侧是 WebCrypto 的 Ed25519），因此能在 Node 里用假实现测。 */
export interface RosterStampPort {
  sign(privateKeyHex: string, payload: Uint8Array): Promise<string>;
  verify(publicKeyHex: string, payload: Uint8Array, signatureHex: string): Promise<boolean>;
}

/**
 * 要签名的**规范字节**：按 deviceId 排序、字段顺序固定。
 *
 * 两边必须逐字节一致，否则会出现"签名明明是对的、验章就是不过"这种最难查的问题 ——
 * 所以序列化只有这一个出口，序列化与验章都调它。
 */
export function rosterPayload(devices: readonly DeviceRecord[]): Uint8Array {
  const normalized = [...devices]
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
    .map((device) => ({
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      addedAt: device.addedAt,
      ...(device.name === undefined ? {} : { name: device.name }),
      ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
      ...(device.bannedAt === undefined ? {} : { bannedAt: device.bannedAt }),
    }));
  return utf8(JSON.stringify(normalized));
}

/** 给名单盖章（私钥由调用方提供，**不落盘**）。 */
export async function stampRoster(input: {
  roster: DeviceRosterList;
  managementPrivateKey: string;
  managementPublicKey: string;
  port: RosterStampPort;
  at: number;
}): Promise<RosterStamp> {
  const signature = await input.port.sign(
    input.managementPrivateKey,
    rosterPayload(input.roster.list()),
  );
  return { v: 1, managementPublicKey: input.managementPublicKey, signature, at: input.at };
}

/** 从落盘文本里取出盖章（没有就返回 undefined；**不做校验**，校验是 `assessRosterTrust` 的事）。 */
export function readRosterStamp(text: string): RosterStamp | undefined {
  try {
    const parsed = JSON.parse(text) as { stamp?: unknown };
    const stamp = parsed?.stamp;
    if (stamp === null || typeof stamp !== 'object') return undefined;
    const candidate = stamp as Partial<RosterStamp>;
    if (candidate.v !== 1) return undefined;
    if (typeof candidate.managementPublicKey !== 'string' || typeof candidate.signature !== 'string') return undefined;
    if (typeof candidate.at !== 'number') return undefined;
    return {
      v: 1,
      managementPublicKey: candidate.managementPublicKey,
      signature: candidate.signature,
      at: candidate.at,
    };
  } catch {
    return undefined;
  }
}

export type RosterTrust = 'stamped-verified' | 'unstamped' | 'key-mismatch' | 'bad-signature';

export interface RosterTrustResult {
  trust: RosterTrust;
  roster: DeviceRosterList;
  stamp?: RosterStamp;
  /** 给人看的一句话（中文，含"该怎么办"）。 */
  message: string;
}

/**
 * 读名单并判断可信度。**这是应用唯一该用的入口**。
 *
 * 策略（与文档里写的"管理密钥签发；没盖章不认"一致）：
 *  - 本机没配管理密钥 → 不盖章也能用，但**明确告诉调用方当前是 `unstamped`**（不假装可信）；
 *  - 本机配了管理密钥 → 没盖章算 `unstamped`、章是别的密钥算 `key-mismatch`、验不过算 `bad-signature`，
 *    这三种都由调用方**拒绝使用**（`trust !== 'stamped-verified'`）。
 */
export async function assessRosterTrust(input: {
  text: string;
  port: RosterStampPort;
  expectedManagementKey?: string;
}): Promise<RosterTrustResult> {
  const roster = parseRoster(input.text);
  const stamp = readRosterStamp(input.text);

  if (stamp === undefined) {
    return {
      trust: 'unstamped',
      roster,
      message:
        input.expectedManagementKey === undefined
          ? '名单没有管理密钥盖章（本机也没配管理密钥，按旧行为继续）'
          : '名单没有管理密钥盖章，但本机配置了管理密钥 → 不认这份名单',
    };
  }
  if (input.expectedManagementKey !== undefined && stamp.managementPublicKey !== input.expectedManagementKey) {
    return {
      trust: 'key-mismatch',
      roster,
      stamp,
      message: `名单是用另一把管理密钥（${stamp.managementPublicKey.slice(0, 12)}…）盖的，与本机配置的不一致 → 不认`,
    };
  }
  const ok = await input.port.verify(stamp.managementPublicKey, rosterPayload(roster.list()), stamp.signature);
  if (!ok) {
    return {
      trust: 'bad-signature',
      roster,
      stamp,
      message: '名单的管理密钥盖章验不过（名单被改过或签名损坏）→ 不认',
    };
  }
  return { trust: 'stamped-verified', roster, stamp, message: '名单已由管理密钥盖章并验证通过' };
}

/** 名单要能本地落盘与备份：它决定了"谁的内容可信"，丢了就得重新配对。 */
export function serializeRoster(roster: DeviceRosterList, options: { stamp?: RosterStamp } = {}): string {
  const payload: PersistedRoster = {
    v: 1,
    devices: roster.list(),
    ...(options.stamp === undefined ? {} : { stamp: options.stamp }),
  };
  return JSON.stringify(payload, null, 2);
}

export function parseRoster(text: string): DeviceRosterList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`设备名单解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('设备名单必须是对象');
  const record = parsed as Partial<PersistedRoster>;
  if (record.v !== 1) throw new Error(`不支持的设备名单版本：${String(record.v)}`);
  if (!Array.isArray(record.devices)) throw new Error('设备名单缺少 devices 数组');

  const devices: DeviceRecord[] = record.devices.map((item, index) => {
    if (item === null || typeof item !== 'object') throw new Error(`第 ${index + 1} 个设备记录不是对象`);
    const entry = item as Partial<DeviceRecord>;
    if (typeof entry.deviceId !== 'string' || entry.deviceId === '') throw new Error(`第 ${index + 1} 个设备缺少 deviceId`);
    // 公钥允许为空：现在的同步模式是"共享口令自动发现"，此时没有公钥可记；
    // 显式配对（公钥交换）之后才会有。空公钥的设备**不参与验签**（见 `toVerifierMap`），
    // 但必须在名单里——否则吊销状态一重启就丢，GC 的判据也就跟着错。
    if (typeof entry.publicKey !== 'string') throw new Error(`设备 ${entry.deviceId} 的 publicKey 不是字符串`);
    if (typeof entry.addedAt !== 'number') throw new Error(`设备 ${entry.deviceId} 缺少 addedAt`);
    const result: DeviceRecord = { deviceId: entry.deviceId, publicKey: entry.publicKey, addedAt: entry.addedAt };
    if (entry.name !== undefined) result.name = entry.name;
    if (entry.revokedAt !== undefined) result.revokedAt = entry.revokedAt;
    if (entry.bannedAt !== undefined) result.bannedAt = entry.bannedAt;
    return result;
  });

  return new DeviceRosterList(devices);
}

/**
 * 所有活跃设备都已并入的最低位点：owner 的第 N 号段，只有 N <= 这个值才可回收。
 * 缺项按 0 处理（保守：没声明就当没并入）。
 */
export function safeThroughSeq(sources: Iterable<AckSource>, activeDevices: readonly string[], owner: string): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const deviceId of activeDevices) {
    let value = 0;
    for (const source of sources) {
      if (source.deviceId !== deviceId) continue;
      value = source.ack[owner] ?? 0;
      break;
    }
    lowest = Math.min(lowest, value);
  }
  return Number.isFinite(lowest) ? lowest : 0;
}

export interface CollectionInput {
  owner: string;
  seq: number;
  /** owner 是否仍在活跃名单里（退役设备的遗留段也需要回收）。 */
  ownerActive: boolean;
  safeThrough: number;
  now: number;
  /** 该段最后一次在 manifest 中出现的时间，用于宽限期判定。 */
  lastSeenAt: number;
  graceMs: number;
}

export interface CollectionDecision {
  collect: boolean;
  reason: string;
}

/** 保守 GC 判定：默认先进 trash，宽限期结束才真正删除。 */
export function decideCollection(input: CollectionInput): CollectionDecision {
  const age = input.now - input.lastSeenAt;
  if (!input.ownerActive) {
    return age >= input.graceMs
      ? { collect: true, reason: 'owner 已退役且超过宽限期' }
      : { collect: false, reason: 'owner 已退役但仍在宽限期内' };
  }
  if (input.seq > input.safeThrough) {
    return { collect: false, reason: `尚有设备未并入（safeThrough=${input.safeThrough}）` };
  }
  if (age < input.graceMs) {
    return { collect: false, reason: `在宽限期内（剩余 ${Math.max(0, input.graceMs - age)} ms）` };
  }
  return { collect: true, reason: '名单内全部设备已并入且超过宽限期' };
}
