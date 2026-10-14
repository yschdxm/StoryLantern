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
  /** 本机公钥（十六进制）；弱模式下为空——弱模式没有可发布的逐设备公钥。 */
  readonly publicKeyHex: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
  /**
   * 验签。**必须用"被声称那台设备"的公钥**，而不是拿自己的密钥再签一遍——
   * 后者只能证明"我签过"，证明不了"这段是它写的"。
   *
   * 弱模式（HMAC）下没有逐设备公钥，实现会在 `publicKeyHex` 为空时退回"组内密钥验证"，
   * 并因此**无法区分是哪台设备**——这正是界面上要明说弱模式的原因。
   */
  verify(publicKeyHex: string, message: Uint8Array, signature: Uint8Array): Promise<boolean>;
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
  roster: { active: ReadonlySet<string>; revoked: ReadonlySet<string>; publicKeyOf?: (deviceId: string) => string | undefined },
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
  const signature = fromHex(envelope.signature);
  if (signature === undefined) return { ok: false, reason: '签名不是合法的十六进制' };

  const publicKeyHex = roster.publicKeyOf?.(envelope.deviceId) ?? '';
  // 强模式必须能拿到对方公钥：拿不到就说明"这台设备还没公布公钥"，
  // 此时宁可拒绝，也不能退化成"自己签自己验"（那样等于没验）。
  if (signer.algorithm === 'ed25519' && publicKeyHex === '') {
    return { ok: false, reason: `名单里没有设备 ${envelope.deviceId} 的公钥，无法验签` };
  }

  const ok = await signer.verify(publicKeyHex, payload, signature);
  return ok ? { ok: true } : { ok: false, reason: '签名验证失败（内容可能被改过，或不是它写的）' };
}
