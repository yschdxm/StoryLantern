import type { SyncBackend } from './backend.ts';
import type { DeviceRosterList } from './roster.ts';
import {
  KEYRING_FILE,
  createKeyring,
  openKeyring,
  parseKeyring,
  serializeKeyring,
  type KeyWrapPort,
  type Keyring,
} from './keyring.ts';

/**
 * keyring（"一人一把锁"的钥匙包）在共享目录里的**取用规则**。
 *
 * 放在 sync-core 而不是应用里，是因为它只依赖 `SyncBackend` / `KeyWrapPort` / `Keyring`
 * 三样东西——本来就属于这一层；这样应用侧只剩"接线"，也避免那个文件超长。
 *
 * 规则（已与用户对齐）：
 *  - 共享目录里没有 keyring → **我建一份**，只包给我自己（epoch 1）；
 *  - 有，而且**能打开**（说明包里我）：如果它还覆盖了我认识的所有设备 → 直接用；
 *    不在成员侧换代（那等于自任库主人、要给每个对端重包一遍，真机上撞旧 X25519 对端就会失败）；
 *  - 有，但**打不开**（没包给我）→ **绝不换代**：换代要用名单里每台设备的协商公钥重新包，
 *    而我此刻并不知道别人的公钥，换出来会把其它设备锁在外面。
 *    正确做法是走加入流程（写 join 请求，等一台已授权设备接纳）——所以这里只如实报告"我不在里面"。
 */

/** 读共享目录里的 keyring（读不到/坏数据都当"没有"）。 */
export async function readKeyring(backend: SyncBackend): Promise<Keyring | undefined> {
  try {
    return parseKeyring(new TextDecoder().decode(await backend.get(KEYRING_FILE)));
  } catch {
    return undefined;
  }
}

/** 我在里面、但名单里这些对端还没进钥匙包（需要由能服务它们的设备完成换代）。 */
export interface EnsureKeyringPending {
  pendingPeers?: string[];
}

export type EnsureKeyringResult =
  | (EnsureKeyringPending & { mine: true; epoch: number; keyring: Keyring; contentKey: Uint8Array })
  | (EnsureKeyringPending & { mine: false; epoch: number; keyring: Keyring });

export interface EnsureKeyringInput {
  backend: SyncBackend;
  deviceId: string;
  /** 本机的协商密钥对（公钥用来"收自己那份"）。 */
  agreement: { publicKey: string; privateKey: string };
  /** 已认识的对端协商公钥（deviceId -> 十六进制）。 */
  peerAgreementKeys: Readonly<Record<string, string>>;
  /** 包装/解包实现（app 侧是 WebCrypto 的 X25519 + HKDF + AES-GCM）。 */
  keyWrap: KeyWrapPort;
  /** 设备名单：给了就先自愈（把已被永久禁用的设备从钥匙包里剔掉）。 */
  roster?: DeviceRosterList;
}

export async function ensureKeyring(input: EnsureKeyringInput): Promise<EnsureKeyringResult> {
  const { backend, deviceId, agreement, keyWrap } = input;

  // 先自愈：钥匙包里还留着已被永久禁用的设备时，换代把它剔掉（必须在下面读钥匙之前）。
  if (input.roster !== undefined && input.roster.bannedIds().length > 0) {
    try {
      await healBannedFromKeyring({
        backend,
        keyWrap,
        roster: input.roster,
        deviceId,
        selfAgreementKey: agreement.publicKey,
        peerAgreementKeys: input.peerAgreementKeys,
      });
    } catch {
      // 还是失败：下次同步再试（黑名单已生效）
    }
  }
  const recipients = [
    { deviceId, publicKey: agreement.publicKey },
    ...Object.entries(input.peerAgreementKeys)
      .filter(([peerId, publicKey]) => peerId !== deviceId && publicKey !== '')
      .map(([peerId, publicKey]) => ({ deviceId: peerId, publicKey })),
  ];

  let existing: Keyring | undefined;
  // 临时诊断：把"读钥匙包到底发生了什么"记下来，建库失败时一并带出去（查完即删）
  let readNote = "没读到";
  try {
    existing = parseKeyring(new TextDecoder().decode(await backend.get(KEYRING_FILE)));
    readNote = "读到并解析成功（epoch " + existing.epoch + "，entries " + existing.entries.length + "）";
  } catch (cause) {
    // 读不到 ≠ 还没有：网络/权限/格式类错误必须**抛出去**，
    // 否则会被当成"要新建库"，本机就悄悄自立为库主人——既不加入也不报错（真机踩到：MuMu 读失败却显示"完成"）。
    const message = cause instanceof Error ? cause.message : String(cause);
    readNote = "读失败：" + message;
    if (!/404|not[- ]?found|不存在|找不到/i.test(message)) throw cause;
    existing = undefined; // 确实还没有：按"要新建"处理
  }

  if (existing !== undefined) {
    try {
      const contentKey = await openKeyring(keyWrap, existing, deviceId, agreement.privateKey, agreement.publicKey);
      const known = new Set(existing.entries.map((entry) => entry.deviceId));
      const missing = recipients.filter((recipient) => !known.has(recipient.deviceId));
      // 我在里面、且有对端还没进钥匙包：**不在这里换代**。
      //
      // 新设备加入走的是 join/ + acceptJoinRequests（那条路会把新设备包进来，已被真机验证）；
      // 而在成员侧换代等于"自任库主人"、要给**每个**对端重包一遍——
      // 真机上只要名单里有一个旧 X25519 对端，这一步就会直接失败（用户手机上踩到过）。
      if (missing.length > 0) {
        return {
          mine: true,
          epoch: existing.epoch,
          keyring: existing,
          contentKey,
          pendingPeers: missing.map((recipient) => recipient.deviceId),
        };
      }
      return { mine: true, epoch: existing.epoch, keyring: existing, contentKey };
    } catch {
      return { mine: false, epoch: existing.epoch, keyring: existing };
    }
  }

  // 走到这里只可能是"确实还没有钥匙包"（有库的两种情况上面都已返回）→ 新建 epoch 1
  let created;
  try {
    created = await createKeyring(keyWrap, recipients, 1);
  } catch (cause) {
    // 把读钥匙包的真实情况带出去（临时诊断，查完即删）
    throw new Error(readNote + "｜建库失败：" + (cause instanceof Error ? cause.message : String(cause)));
  }
  await backend.put(KEYRING_FILE, new TextEncoder().encode(serializeKeyring(created.keyring)));
  return { mine: true, epoch: created.keyring.epoch, keyring: created.keyring, contentKey: created.contentKey };
}

export interface RotateKeyringInput {
  backend: SyncBackend;
  keyWrap: KeyWrapPort;
  /** 新钥匙要包给谁（**只包含留下的人**：被禁用/吊销的绝不能出现在这里）。 */
  recipients: ReadonlyArray<{ deviceId: string; publicKey: string }>;
}

/**
 * 换代：换一把新的数据钥匙，只包给名单里留下的人。
 *
 * 这就是"永久禁用"的另一半（前一半是拒绝它的签名）：
 * 被拉黑的那台没有新钥匙 → 它**解不出**以后的内容；它手里的旧内容收不回（写进文档）。
 * 写完**读回校验**：哑存储没有 CAS，若被别的设备抢先写了另一个 epoch，就报错让下次同步再来。
 */
export async function rotateKeyring(input: RotateKeyringInput): Promise<{ keyring: Keyring; contentKey: Uint8Array }> {
  const existing = await readKeyring(input.backend);
  const epoch = (existing?.epoch ?? 0) + 1;
  const created = await createKeyring(input.keyWrap, input.recipients, epoch);
  await input.backend.put(KEYRING_FILE, new TextEncoder().encode(serializeKeyring(created.keyring)));
  const verify = await readKeyring(input.backend);
  if (verify?.epoch !== epoch) throw new Error(`换代写入被抢先（期望 epoch ${epoch}，读到 ${verify?.epoch ?? 0}），下次同步再试`);
  return created;
}

export interface HealKeyringInput {
  backend: SyncBackend;
  keyWrap: KeyWrapPort;
  roster: DeviceRosterList;
  deviceId: string;
  /** 本机协商公钥（留下的人里包含本机）。 */
  selfAgreementKey: string;
  /** 已认识的对端协商公钥（只有它们才包得进去）。 */
  peerAgreementKeys: Readonly<Record<string, string>>;
}

/**
 * 自愈：keyring 里还留着**已被永久禁用**的设备时，换代把它剔掉。
 *
 * 为什么需要：拉黑时的换代可能失败（被别的设备抢先写了另一个 epoch）或写回被回滚，
 * 那时黑名单已生效但钥匙包里还留着它——下一次同步在这里自动收敛。
 * 只剔**永久禁用**的：临时吊销（revokedAt）按设计仍可读，不该被踢出钥匙包。
 *
 * 返回是否真的换了一代。
 */
export async function healBannedFromKeyring(input: HealKeyringInput): Promise<boolean> {
  const banned = new Set(input.roster.bannedIds());
  if (banned.size === 0) return false;
  const current = await readKeyring(input.backend);
  const stale =
    current === undefined
      ? false
      : current.entries.some((entry) => entry.deviceId !== input.deviceId && banned.has(entry.deviceId));
  if (!stale) return false;

  const kept = input.roster
    .list()
    .filter((record) => record.bannedAt === undefined && record.revokedAt === undefined)
    .flatMap((record) => {
      if (record.deviceId === input.deviceId) return [{ deviceId: record.deviceId, publicKey: input.selfAgreementKey }];
      const publicKey = input.peerAgreementKeys[record.deviceId] ?? '';
      return publicKey === '' ? [] : [{ deviceId: record.deviceId, publicKey }];
    });
  await rotateKeyring({ backend: input.backend, keyWrap: input.keyWrap, recipients: kept });
  return true;
}
