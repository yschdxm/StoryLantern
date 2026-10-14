/**
 * 每台设备一把"锁和钥匙"：签名与验签的端口。
 *
 * 为什么放在端口后面：这一层**不实现密码学**（零第三方依赖，浏览器与 Node 的
 * WebCrypto 都能给出实现），只定义"要能干什么"与"待签数据长什么样"。
 * 于是收敛逻辑可以在 Node 里用假签名器测，真机再用 WebCrypto 实现。
 *
 * 两种强度的区别（界面必须如实告诉用户）：
 *  - `ed25519`：**强**。每台设备一对密钥，私钥不出设备；别人伪造不了它写的东西。
 *  - `hmac-sha256`：**弱**。共享一把"组内密钥"，只能证明"来自组内"，**证明不了是哪台设备**，
 *    因此组内成员之间可以互相冒充。老设备上 WebCrypto 没有 Ed25519 时只能退到这个模式。
 */

export type SigningAlgorithm = 'ed25519' | 'hmac-sha256';

export interface SignerPort {
  readonly algorithm: SigningAlgorithm;
  /** 本机身份（写进签名记录，验签时用来挑公钥）。 */
  readonly deviceId: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
  /**
   * 验签。`deviceId` 是"这段自称是谁写的"。
   *
   * 弱的 HMAC 模式下无法区分成员，因此实现会在 `deviceId` 不在名单里时直接拒绝——
   * 这正是"黑名单/名单"起作用的地方（名单本身另有盖章，见 `roster`）。
   */
  verify(deviceId: string, message: Uint8Array): Promise<boolean>;
}

/** 待签数据规范化：把"这是什么、属于谁、内容是什么"拼成一段确定性的字节。 */
export function signingPayload(input: {
  /** 用途：段、名单、纪元密钥……不同用途不能互相顶替，否则可被重放。 */
  purpose: 'segment' | 'roster' | 'epoch-key';
  /** 逻辑位置（段路径 / 名单版本 / 纪元号）。 */
  ref: string;
  /** 内容哈希（或内容字节的十六进制摘要）——只签摘要，避免把大段内容带进来。 */
  digest: string;
}): Uint8Array {
  return new TextEncoder().encode(`storylantern/v1/${input.purpose}/${input.ref}/${input.digest}`);
}

/** 十六进制：签名要写进文件名/清单，必须是稳定且可读的。 */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array | undefined {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** 一段签名记录：跟着段/名单一起走，读的人据此判断"是谁写的、算不算数"。 */
export interface SignedEnvelope {
  /** 签名者自称的 deviceId。 */
  deviceId: string;
  algorithm: SigningAlgorithm;
  /** 签名字节的十六进制。 */
  signature: string;
}

export interface VerifyOutcome {
  ok: boolean;
  /** 不接受时的原因（要能直接展示给用户，不能只说"失败"）。 */
  reason?: string;
}

/**
 * 按"名单 + 黑名单"验签：**先看人，再看签**。
 *
 * 顺序很重要：被踢的设备即使签得没错（它确实有自己那把钥匙），也必须被拒绝——
 * 因为它已经不在名单里。
 */
export async function verifySigned(
  signer: SignerPort,
  envelope: SignedEnvelope,
  payload: Uint8Array,
  roster: { active: ReadonlySet<string>; revoked: ReadonlySet<string> },
): Promise<VerifyOutcome> {
  if (envelope.signature === '') return { ok: false, reason: '没有签名' };
  if (roster.revoked.has(envelope.deviceId)) {
    return { ok: false, reason: `设备 ${envelope.deviceId} 已被移出名单` };
  }
  if (!roster.active.has(envelope.deviceId)) {
    return { ok: false, reason: `设备 ${envelope.deviceId} 不在名单里` };
  }
  if (envelope.algorithm !== signer.algorithm) {
    return { ok: false, reason: `签名算法不一致（收到 ${envelope.algorithm}）` };
  }
  const ok = await signer.verify(envelope.deviceId, payload);
  return ok ? { ok: true } : { ok: false, reason: '签名验证失败（内容可能被改过）' };
}
