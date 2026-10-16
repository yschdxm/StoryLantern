/**
 * 一人一把锁：内容密钥按名单里**每台设备的公钥各包一份**。
 *
 * 这一层做什么：
 *  - 生成一把随机的**内容密钥**（真正用来加密段/清单的那把）；
 *  - 对名单里每台设备，用"只有它能解"的方式把内容密钥包一份放进 `keyring`；
 *  - 有人被踢 → 换一把新的内容密钥、只包给剩下的人 → 被踢的那台**拿不到新钥匙**。
 *
 * 为什么协商密钥与签名密钥分开：签名那把 Ed25519 只能签，不能做密钥协商。
 * 所以每台设备有**两对**密钥：Ed25519（证明"是谁写的"）+ P-256（收自己的那份钥匙）。
 *
 * 这一层**不实现密码学**（零第三方依赖，浏览器与 Node 的 WebCrypto 都能给实现），
 * 只定义"要能干什么"与 keyring 的数据形状，因此逻辑能在 Node 里用假实现测。
 */

import { describeError } from './error-text.ts';

/** 密钥协商与包装的端口。实现见 app 侧 `data/sync/envelope.ts`。 */
export interface KeyWrapPort {
  /** 生成一对 P-256 密钥；公钥（raw 十六进制）随设备清单发布。 */
  generateAgreementKeys(): Promise<{ publicKey: string; privateKey: string }>;
  /** 生成 32 字节随机内容密钥。 */
  randomContentKey(): Promise<Uint8Array>;
  /** 用对方公钥把内容密钥包起来（ECDH → HKDF → AES-GCM），返回 base64。 */
  wrapFor(recipientPublicKeyHex: string, contentKey: Uint8Array): Promise<string>;
  /**
   * 本机能不能给这个公钥包钥匙（**可选**）。
   *
   * 为什么需要：曲线换代（X25519 → P-256）之后，名单里可能还留着**旧曲线**对端（公钥 32 字节），
   * 而真机 WebView 没有 X25519 —— 建库时若给每个对端都包一遍，这里会硬失败（真机踩到过）。
   * 实现方按"公钥长度/曲线 + 本机能力"回答；没实现就视为"都能包"（不能因为缺信息而少包）。
   */
  canWrapFor?(recipientPublicKeyHex: string): Promise<boolean>;
  /**
   * 用自己的私钥解开自己的那一份。不是给自己包的会失败（AEAD 拒绝）。
   *
   * 为什么要同时给公钥：浏览器里**不能**从私钥导出公钥，而 HKDF 的 salt 绑了双方公钥，
   * 所以解包方必须自己知道公钥（本机存密钥时本来就公私钥一起存）。
   */
  unwrapWith(myPrivateKey: string, myPublicKey: string, wrapped: string): Promise<Uint8Array>;
}

export interface KeyringEntry {
  deviceId: string;
  /** base64：只有该设备能解。 */
  wrapped: string;
}

export interface Keyring {
  v: 1;
  /** 第几代内容密钥。**每踢一次人 +1**：老 epoch 的东西还没换。 */
  epoch: number;
  entries: KeyringEntry[];
}

export const KEYRING_FILE = 'keyring.json';

/**
 * 造一份新 keyring：内容密钥只包给 `recipients` 里的人。
 *
 * 被踢的人不在这里 → 它拿不到这把钥匙 → 之后发的东西它解不开。
 * （它手里**已有**的旧内容收不回，这是任何方案都做不到的下限。）
 */
export async function createKeyring(
  port: KeyWrapPort,
  recipients: ReadonlyArray<{ deviceId: string; publicKey: string }>,
  epoch: number,
): Promise<{ keyring: Keyring; contentKey: Uint8Array }> {
  const contentKey = await port.randomContentKey();
  const entries: KeyringEntry[] = [];
  for (const recipient of recipients) {
    if (recipient.publicKey === '') {
      // 没公布公钥的设备拿不到钥匙——强模式下的正确行为，不能"发个明文版给它"
      throw new Error(`设备 ${recipient.deviceId} 还没公布公钥，无法把钥匙包给它`);
    }
    entries.push({ deviceId: recipient.deviceId, wrapped: await port.wrapFor(recipient.publicKey, contentKey) });
  }
  return { keyring: { v: 1, epoch, entries }, contentKey };
}

/** 从 keyring 里取自己那一份并解开；不在里面就是"没你的钥匙"。 */
export async function openKeyring(
  port: KeyWrapPort,
  keyring: Keyring,
  deviceId: string,
  myPrivateKey: string,
  myPublicKey: string,
): Promise<Uint8Array> {
  const entry = keyring.entries.find((candidate) => candidate.deviceId === deviceId);
  if (entry === undefined) {
    throw new Error(`这把钥匙没有包给设备 ${deviceId}（可能已被移出名单）`);
  }
  return port.unwrapWith(myPrivateKey, myPublicKey, entry.wrapped);
}

/** 解析（校验形状，坏数据要说清哪坏了）。 */
export function parseKeyring(text: string): Keyring {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`keyring 不是合法 JSON：${describeError(cause)}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('keyring 不是对象');
  const record = raw as Record<string, unknown>;
  if (record.v !== 1) throw new Error(`keyring 版本不认识：${String(record.v)}`);
  if (typeof record.epoch !== 'number' || !Number.isFinite(record.epoch)) throw new Error('keyring 缺少 epoch');
  if (!Array.isArray(record.entries)) throw new Error('keyring 缺少 entries');
  const entries: KeyringEntry[] = record.entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('keyring 的 entry 不是对象');
    const item = entry as Record<string, unknown>;
    if (typeof item.deviceId !== 'string' || typeof item.wrapped !== 'string') {
      throw new Error('keyring 的 entry 缺少 deviceId/wrapped');
    }
    return { deviceId: item.deviceId, wrapped: item.wrapped };
  });
  return { v: 1, epoch: record.epoch, entries };
}

export function serializeKeyring(keyring: Keyring): string {
  return JSON.stringify(keyring);
}



