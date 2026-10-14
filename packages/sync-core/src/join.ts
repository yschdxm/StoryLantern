/**
 * 加入请求：新设备"输密码进来"这一步。
 *
 * 设计（已定）：
 *  - **密码是门**：新设备用密码派生的钥匙写一份"我想加入"，里面带自己的**公钥**；
 *  - 已授权的设备读到后**验密码证明** ✓ → 把当前数据钥匙**包一份给它**（用它的公钥）→ 它就能读；
 *  - **公钥是明文**（公钥不是秘密）✓，所以"谁给谁包钥匙"不会有死锁；
 *  - 被拉黑的设备：**一律不认它的加入请求、也不给它包新钥匙** → 它的密钥解不出新内容。
 *
 * 这一层不实现密码学：只用两个端口（`seal`/`open`，由 app 侧接到"密码派生的钥匙"上），
 * 因此格式与校验逻辑能在 Node 里用假实现测。
 */

/** 密码证明的端口：seal/open 用的钥匙来自**密码**（不是设备密钥）。 */
export interface JoinProofPort {
  seal(plaintext: Uint8Array): Promise<string>;
  open(sealed: string): Promise<Uint8Array>;
}

/** 加入请求所在的相对路径（明文区，公钥与证明都在里面）。 */
export const JOIN_PREFIX = 'join/';

export function joinPath(deviceId: string): string {
  return `${JOIN_PREFIX}${deviceId}.json`;
}

export interface JoinRequest {
  v: 1;
  deviceId: string;
  /** 签名公钥（Ed25519，十六进制）：永久身份。 */
  publicKey: string;
  /** 协商公钥（X25519，十六进制）：把数据钥匙包给它时要用。 */
  agreementKey: string;
  /** 密码证明（base64）：能解开就说明它知道门码。 */
  proof: string;
  /** 写入时间（毫秒）：用来判断"这是新的请求还是旧的"。 */
  at: number;
}

/** 证明里封的具体内容：绑定设备身份与两把公钥，防止把别人的证明搬过来用。 */
function proofPayload(input: { deviceId: string; publicKey: string; agreementKey: string }): Uint8Array {
  return new TextEncoder().encode(
    `storylantern/join/v1/${input.deviceId}/${input.publicKey}/${input.agreementKey}`,
  );
}

export async function createJoinRequest(
  port: JoinProofPort,
  input: { deviceId: string; publicKey: string; agreementKey: string; at?: number },
): Promise<JoinRequest> {
  if (input.publicKey === '') throw new Error('加入请求必须带签名公钥');
  if (input.agreementKey === '') throw new Error('加入请求必须带协商公钥（否则别人没法把钥匙包给你）');
  return {
    v: 1,
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    agreementKey: input.agreementKey,
    proof: await port.seal(proofPayload(input)),
    at: input.at ?? Date.now(),
  };
}

export interface JoinDecision {
  ok: boolean;
  /** 不接受的原因，要能直接展示给用户。 */
  reason?: string;
}

/**
 * 校验一份加入请求。
 *
 * **先查黑名单再看证明**：被拉黑的设备即使知道密码，也不该被重新接纳。
 * （顺序很重要：反过来的话"它输密码又能进来"这句就白说了。）
 */
export async function verifyJoinRequest(
  port: JoinProofPort,
  request: JoinRequest,
  options: { revoked: ReadonlySet<string>; knownSince?: (deviceId: string) => number | undefined },
): Promise<JoinDecision> {
  if (options.revoked.has(request.deviceId)) {
    return { ok: false, reason: `设备 ${request.deviceId} 已被永久禁用（黑名单）` };
  }
  if (request.publicKey === '' || request.agreementKey === '') {
    return { ok: false, reason: '加入请求缺少公钥' };
  }
  let opened: Uint8Array;
  try {
    opened = await port.open(request.proof);
  } catch {
    return { ok: false, reason: '密码证明解不开（口令不对，或证明被改过）' };
  }
  const expected = proofPayload(request);
  if (opened.length !== expected.length) return { ok: false, reason: '密码证明与请求内容不符' };
  for (let index = 0; index < expected.length; index += 1) {
    if (opened[index] !== expected[index]) return { ok: false, reason: '密码证明与请求内容不符' };
  }
  const known = options.knownSince?.(request.deviceId);
  if (known !== undefined && known >= request.at) {
    // 老请求重放：不重复处理（幂等）
    return { ok: false, reason: '这是一份旧的加入请求（已处理过）' };
  }
  return { ok: true };
}

export function parseJoinRequest(text: string): JoinRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`加入请求不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('加入请求不是对象');
  const record = raw as Record<string, unknown>;
  if (record.v !== 1) throw new Error(`加入请求版本不认识：${String(record.v)}`);
  for (const field of ['deviceId', 'publicKey', 'agreementKey', 'proof'] as const) {
    if (typeof record[field] !== 'string') throw new Error(`加入请求缺少 ${field}`);
  }
  if (typeof record.at !== 'number' || !Number.isFinite(record.at)) throw new Error('加入请求缺少 at');
  return {
    v: 1,
    deviceId: record.deviceId as string,
    publicKey: record.publicKey as string,
    agreementKey: record.agreementKey as string,
    proof: record.proof as string,
    at: record.at,
  };
}

export function serializeJoinRequest(request: JoinRequest): string {
  return JSON.stringify(request);
}
