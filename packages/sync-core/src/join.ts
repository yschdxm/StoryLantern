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

import { describeError } from './error-text.ts';

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
  /** 密码证明（base64）：能解开就说明它知道门码。用恢复密钥加入时可以是空串。 */
  proof: string;
  /**
   * 恢复证明（十六进制签名）：忘记口令的设备用它加入。
   *
   * 共享目录里公布的恢复公钥能验证它——这就是「用恢复密钥重置口令」的实际含义。
   */
  recoveryProof?: string;
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
  input: { deviceId: string; publicKey: string; agreementKey: string; at?: number; recoveryProof?: string },
): Promise<JoinRequest> {
  // 签名公钥**可以为空**：WebView 不支持 Ed25519 的设备处于「弱签名」模式，没有公钥可带
  //（名单里本来就允许「没有公钥」的同伴，真机上就是这种设备要加入）。
  // 真正不能少的是**协商公钥**——库主人要用它把数据钥匙包给你。
  if (input.agreementKey === '') throw new Error('加入请求必须带协商公钥（否则别人没法把钥匙包给你）');
  return {
    v: 1,
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    agreementKey: input.agreementKey,
    // 有恢复证明时不必有密码证明（两条路二选一即可）
    proof: input.recoveryProof === undefined ? await port.seal(proofPayload(input)) : "",
    ...(input.recoveryProof === undefined ? {} : { recoveryProof: input.recoveryProof }),
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
  options: {
    revoked: ReadonlySet<string>;
    knownSince?: (deviceId: string) => number | undefined;
    /** 验恢复证明（有恢复公钥时才给）：给了就允许「没口令但有恢复证明」的设备加入。 */
    verifyRecovery?: (request: JoinRequest) => Promise<{ ok: boolean; reason?: string }>;
  },
): Promise<JoinDecision> {
  if (options.revoked.has(request.deviceId)) {
    return { ok: false, reason: `设备 ${request.deviceId} 已被永久禁用（黑名单）` };
  }
  if (request.agreementKey === '') {
    return { ok: false, reason: '加入请求缺少公钥' };
  }
  // 两条路：带正确口令的密码证明，或者恢复密钥签名的恢复证明。
  if (request.proof !== "") {
    let opened: Uint8Array;
    try {
      opened = await port.open(request.proof);
    } catch {
      return await viaRecovery(request, options, "密码证明解不开（口令不对，或证明被改过）");
    }
    const expected = proofPayload(request);
    const same = opened.length === expected.length && expected.every((byte, index) => opened[index] === byte);
    if (!same) return await viaRecovery(request, options, "密码证明与请求内容不符");
  } else {
    const verdict = await tryRecovery(request, options);
    if (verdict !== undefined) return verdict;
  }
  const known = options.knownSince?.(request.deviceId);
  if (known !== undefined && known >= request.at) {
    // 老请求重放：不重复处理（幂等）
    return { ok: false, reason: '这是一份旧的加入请求（已处理过）' };
  }
  return { ok: true };
}

/** 口令那条路失败时，看有没有恢复证明可以救回来。 */
async function viaRecovery(
  request: JoinRequest,
  options: { verifyRecovery?: (request: JoinRequest) => Promise<{ ok: boolean; reason?: string }> },
  failure: string,
): Promise<JoinDecision> {
  if (request.recoveryProof === undefined || request.recoveryProof === "") return { ok: false, reason: failure };
  const verdict = await tryRecovery(request, options);
  if (verdict === undefined) return { ok: false, reason: failure };
  return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason ?? failure };
}

/** 只有恢复证明这一条路时的判定（没给验签器就明确说不接受）。 */
async function tryRecovery(
  request: JoinRequest,
  options: { verifyRecovery?: (request: JoinRequest) => Promise<{ ok: boolean; reason?: string }> },
): Promise<JoinDecision | undefined> {
  if (request.recoveryProof === undefined || request.recoveryProof === "") {
    return { ok: false, reason: "既没有密码证明也没有恢复证明" };
  }
  const recovery = options.verifyRecovery;
  if (recovery === undefined) return { ok: false, reason: "共享目录里还没有恢复公钥，无法验恢复证明" };
  const verdict = await recovery(request);
  return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason ?? "恢复证明不被接受" };
}

export function parseJoinRequest(text: string): JoinRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new Error(`加入请求不是合法 JSON：${describeError(cause)}`);
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
    ...(typeof record.recoveryProof === "string" && record.recoveryProof !== ""
      ? { recoveryProof: record.recoveryProof }
      : {}),
    at: record.at,
  };
}

export function serializeJoinRequest(request: JoinRequest): string {
  return JSON.stringify(request);
}
