import type { SyncBackend } from './backend.ts';
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
 *    否则换代，把我认识的设备一起包进去；
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

export type EnsureKeyringResult =
  | { mine: true; epoch: number; keyring: Keyring; contentKey: Uint8Array }
  | { mine: false; epoch: number; keyring: Keyring };

export interface EnsureKeyringInput {
  backend: SyncBackend;
  deviceId: string;
  /** 本机的协商密钥对（公钥用来"收自己那份"）。 */
  agreement: { publicKey: string; privateKey: string };
  /** 已认识的对端协商公钥（deviceId -> 十六进制）。 */
  peerAgreementKeys: Readonly<Record<string, string>>;
  /** 包装/解包实现（app 侧是 WebCrypto 的 X25519 + HKDF + AES-GCM）。 */
  keyWrap: KeyWrapPort;
}

export async function ensureKeyring(input: EnsureKeyringInput): Promise<EnsureKeyringResult> {
  const { backend, deviceId, agreement, keyWrap } = input;
  const recipients = [
    { deviceId, publicKey: agreement.publicKey },
    ...Object.entries(input.peerAgreementKeys)
      .filter(([peerId, publicKey]) => peerId !== deviceId && publicKey !== '')
      .map(([peerId, publicKey]) => ({ deviceId: peerId, publicKey })),
  ];

  let existing: Keyring | undefined;
  try {
    existing = parseKeyring(new TextDecoder().decode(await backend.get(KEYRING_FILE)));
  } catch {
    existing = undefined; // 还没有 / 读不到：按"要新建"处理
  }

  if (existing !== undefined) {
    try {
      const contentKey = await openKeyring(keyWrap, existing, deviceId, agreement.privateKey, agreement.publicKey);
      const known = new Set(existing.entries.map((entry) => entry.deviceId));
      const missing = recipients.filter((recipient) => !known.has(recipient.deviceId));
      if (missing.length === 0) return { mine: true, epoch: existing.epoch, keyring: existing, contentKey };
      // 我在里面、但还没覆盖我认识的所有设备（例如刚看到的新设备）：往下走，换代
    } catch {
      return { mine: false, epoch: existing.epoch, keyring: existing };
    }
  }

  const epoch = (existing?.epoch ?? 0) + 1;
  const created = await createKeyring(keyWrap, recipients, epoch);
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
