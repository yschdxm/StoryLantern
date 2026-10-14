/**
 * 设备名单与 GC 判定。
 *
 * 为什么需要名单：GC 天然需要一个"所有人都已同步"的判据。哑存储无法提供，
 * 只能在客户端维护一份显式名单——配对即登记、退役必须显式操作（UI 要警告
 * "它离线期间的新数据将不再保留"）。没有名单就只能永不回收，空间无上界。
 */

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
}

/** 名单要能本地落盘与备份：它决定了"谁的内容可信"，丢了就得重新配对。 */
export function serializeRoster(roster: DeviceRosterList): string {
  const payload: PersistedRoster = { v: 1, devices: roster.list() };
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
