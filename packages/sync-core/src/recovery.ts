/**
 * 恢复密钥：**离线保存的一对 Ed25519 密钥**，用来在忘记同步口令时把设备接回来。
 *
 * 为什么不是"用恢复密钥当口令"：口令派生的钥匙只用来写/验加入请求，
 * 而"进入共享目录"靠的是设备自己的密钥包（keyring）。所以恢复密钥的正确角色是：
 *
 *  - 共享目录里公布它的**公钥**（`recovery.json`，公开信息）；
 *  - 私钥由用户**离线保存**（生成时显示一次，界面明说"丢了就再也拿不回来"）；
 *  - 忘记口令的新设备可以**用它签名**自己的加入请求 → 任何已授权设备验签后接纳它
 *    （等价于"用恢复密钥重置了口令"）；
 *  - 它**不能**替设备读旧内容：内容钥匙仍然只包给名单里的设备（这条不要含糊）。
 *
 * 这一层不实现密码学：只用 `RecoveryProofPort`（app 侧是 WebCrypto 的 Ed25519），
 * 所以格式与校验能在 Node 里用假实现测。
 */

export const RECOVERY_FILE = 'recovery.json';

export interface RecoveryProofPort {
  /** 生成一对恢复密钥；私钥要以十六进制交回给用户离线保存。 */
  generate(): Promise<{ publicKey: string; privateKey: string }>;
  sign(privateKeyHex: string, payload: Uint8Array): Promise<string>;
  verify(publicKeyHex: string, payload: Uint8Array, signatureHex: string): Promise<boolean>;
}

export interface RecoveryFile {
  v: 1;
  /** 恢复密钥的公钥（十六进制）：公开，放在共享目录里让任何设备都能验签。 */
  publicKey: string;
  createdAt: number;
}

/**
 * 恢复证明签的内容：**绑定设备与时间**。
 *
 * 绑设备：别人的恢复签名搬不到我这台设备上；
 * 绑时间：避免旧签名被翻出来重放（配合名单里的"已处理时间"判定）。
 */
export function recoveryPayload(input: { deviceId: string; at: number }): Uint8Array {
  return new TextEncoder().encode(`storylantern/recovery/v1/${input.deviceId}/${String(input.at)}`);
}

export async function signJoinWithRecovery(
  port: RecoveryProofPort,
  input: { privateKey: string; deviceId: string; at: number },
): Promise<string> {
  if (input.privateKey === '') throw new Error('没有恢复私钥，签不出恢复证明');
  return port.sign(input.privateKey, recoveryPayload(input));
}

export async function verifyRecoverySignature(
  port: RecoveryProofPort,
  file: RecoveryFile,
  input: { deviceId: string; at: number; signature: string },
): Promise<{ ok: boolean; reason?: string }> {
  if (file.publicKey === '') return { ok: false, reason: '共享目录里的恢复公钥是空的' };
  if (input.signature === '') return { ok: false, reason: '没有带恢复证明' };
  const ok = await port.verify(file.publicKey, recoveryPayload(input), input.signature);
  return ok ? { ok: true } : { ok: false, reason: '恢复证明验签失败（不是这把恢复密钥签的）' };
}

export function parseRecoveryFile(text: string): RecoveryFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`recovery.json 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('recovery.json 不是对象');
  const record = raw as Record<string, unknown>;
  if (record.v !== 1) throw new Error(`recovery.json 版本不认识：${String(record.v)}`);
  if (typeof record.publicKey !== 'string' || record.publicKey === '') throw new Error('recovery.json 缺少公钥');
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
    throw new Error('recovery.json 缺少 createdAt');
  }
  return { v: 1, publicKey: record.publicKey, createdAt: record.createdAt };
}

export function serializeRecoveryFile(file: RecoveryFile): string {
  return JSON.stringify(file);
}
