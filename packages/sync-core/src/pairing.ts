import { fromBase64Url, toBase64Url, utf8 } from '../../oplog/src/bytes.ts';
import type { DeviceRosterList, DeviceRecord } from './roster.ts';

/**
 * 扫码配对。
 *
 * 为什么必须带外（二维码）传而不是走同步通道：真正需要传递的是**端到端加密主密钥**
 * （profile key）。它一旦出现在远端，端到端加密就没有意义了。二维码让密钥只存在于
 * 两台设备的屏幕上，服务器/网盘永远看不到。
 *
 * 安全约束：
 *  - 邀请**一次性且会过期**（默认 10 分钟）；
 *  - 解析时校验结构、主密钥长度与有效期，任何一项不符都明确失败；
 *  - 二维码里包含主密钥，因此只应显示在自己的屏幕上，不要截图外发。
 */

export const PAIRING_SCHEME = 'storylantern://pair';

export interface PairingInvite {
  v: 1;
  /** 发起方设备 id（已配对设备用它互相识别）。 */
  deviceId: string;
  /** 展示用名称（例如"我的手机"）。 */
  name: string;
  /** 端到端加密主密钥（32 字节，base64url）——只在二维码里出现。 */
  profileKey: string;
  createdAt: number;
  expiresAt: number;
  /** 一次性随机数，便于排查"扫的是哪一张"。 */
  nonce: string;
}

export type PairingParseResult =
  | { ok: true; invite: PairingInvite }
  | { ok: false; error: string };

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface CreateInviteInput {
  deviceId: string;
  name: string;
  profileKey: Uint8Array;
  now?: number;
  ttlMs?: number;
  nonce?: string;
}

export function createPairingInvite(input: CreateInviteInput): PairingInvite {
  if (input.profileKey.length !== 32) throw new Error('端到端加密主密钥必须是 32 字节');
  const now = input.now ?? Date.now();
  return {
    v: 1,
    deviceId: input.deviceId,
    name: input.name,
    profileKey: toBase64Url(input.profileKey),
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    nonce: input.nonce ?? Math.random().toString(36).slice(2, 12),
  };
}

/** 编码成可放进二维码的 URI。整段用 base64url 承载，避免特殊字符。 */
export function encodePairingInvite(invite: PairingInvite): string {
  const payload = JSON.stringify(invite);
  return `${PAIRING_SCHEME}?v=1&p=${toBase64Url(utf8(payload))}`;
}

export function decodePairingInvite(uri: string, options: { now?: number } = {}): PairingParseResult {
  const trimmed = uri.trim();
  if (!trimmed.startsWith(`${PAIRING_SCHEME}?`)) return { ok: false, error: '不是 Story Lantern 配对二维码' };

  const query = trimmed.slice(PAIRING_SCHEME.length + 1);
  const params = new URLSearchParams(query);
  if (params.get('v') !== '1') return { ok: false, error: `不支持的配对版本：${params.get('v') ?? '(缺失)'}` };
  const encoded = params.get('p');
  if (!encoded) return { ok: false, error: '配对内容缺失' };

  let invite: PairingInvite;
  try {
    invite = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as PairingInvite;
  } catch (error) {
    return { ok: false, error: `配对内容解析失败：${error instanceof Error ? error.message : String(error)}` };
  }

  if (invite === null || typeof invite !== 'object') return { ok: false, error: '配对内容不是对象' };
  for (const field of ['deviceId', 'name', 'profileKey'] as const) {
    if (typeof invite[field] !== 'string' || invite[field] === '') return { ok: false, error: `缺少字段 ${field}` };
  }
  if (typeof invite.expiresAt !== 'number' || typeof invite.createdAt !== 'number') {
    return { ok: false, error: '配对内容缺少有效期' };
  }

  let keyLength = 0;
  try {
    keyLength = fromBase64Url(invite.profileKey).length;
  } catch {
    return { ok: false, error: '主密钥编码非法' };
  }
  if (keyLength !== 32) return { ok: false, error: `主密钥长度应为 32 字节，实际 ${keyLength}` };

  const now = options.now ?? Date.now();
  if (invite.expiresAt <= now) return { ok: false, error: '配对二维码已过期，请重新生成' };

  return { ok: true, invite };
}

/** 读取二维码里的主密钥字节（构造加密端口时用）。 */
export function profileKeyOf(invite: PairingInvite): Uint8Array {
  return fromBase64Url(invite.profileKey);
}

export function inviteToDeviceRecord(invite: PairingInvite, options: { at?: number; name?: string } = {}): DeviceRecord {
  return {
    deviceId: invite.deviceId,
    addedAt: options.at ?? Date.now(),
    name: options.name ?? invite.name,
  };
}

/** 把邀请里的设备登记进名单（幂等：重复配对只更新名称，不重复添加）。 */
export function pairFromInvite(roster: DeviceRosterList, invite: PairingInvite, options: { at?: number } = {}): DeviceRecord {
  const record = inviteToDeviceRecord(invite, options);
  roster.add(record);
  return record;
}
