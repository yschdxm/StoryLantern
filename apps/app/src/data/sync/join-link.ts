import type { SyncConfig } from './app-sync.ts';

/**
 * 配对链接：把"新设备要能开始同步"所需的一切，变成一段可以**贴过去**的文本。
 *
 * 为什么是链接而不是扫码：真正需要带外传的是**同步口令**（端到端加密的根），它不能出现在远端，
 * 所以只能从一台设备的屏幕传到另一台设备。扫码需要相机 + 二维码解码器（后者是第三方依赖或几百行自实现，
 * 见下），而**粘贴一段文本**在手机上同样两秒完成，且不依赖任何平台能力。
 *
 * 边界（说清楚，别让人误解）：
 *  - 这段文本里含**同步口令**，等同于钥匙：只在自己的设备之间传，不要发到聊天群里；
 *  - 校验和只是**防手抄错**，不是防篡改（能改内容的人也能改校验和）；
 *  - 一次生成的有效期默认 15 分钟，过期要重新生成（与二维码邀请同一条规矩）。
 *
 * 关于 `packages/sync-core/src/pairing.ts`：那是一套"邀请里直接携带端到端主密钥（profileKey）"的设计，
 * 与当前应用的链路（同步口令 → keyring → 内容钥匙）**不是同一条**。把它接上等于换加密根，
 * 属于协议级改动，不该混在"配对 UI"里偷偷做 —— 这里记为**有名字的欠账**，不假装已经接上。
 */

export const SYNC_JOIN_SCHEME = 'storylantern://join';
const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface JoinPayload {
  v: 1;
  kind: 'webdav' | 'folder' | 's3';
  /** WebDAV。 */
  url?: string;
  username?: string;
  password?: string;
  /** 本地文件夹。 */
  folder?: string;
  /** S3。 */
  endpoint?: string;
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  s3SecretAccessKey?: string;
  /** 同步口令（端到端加密的根）：只写、只存设备本地。 */
  secret: string;
  expiresAt: number;
  nonce: string;
}

export type JoinLinkParseResult = { ok: true; payload: JoinPayload } | { ok: false; error: string };

/** FNV-1a 8 位十六进制：只用来防**手抄/截断**，不是密码学校验（注释里写明）。 */
export function checksumOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

/** 从当前配置造一段配对链接。缺关键项（口令/远端）时明确拒绝，而不是生成一段没用的文本。 */
export function createJoinLink(input: {
  config: SyncConfig;
  now?: number;
  ttlMs?: number;
  nonce?: string;
}): { link: string; expiresAt: number } {
  const config = input.config;
  if (config.kind === 'off') throw new Error('还没有选同步方式，无法生成配对链接');
  if (config.secret.trim() === '') throw new Error('还没有填同步口令：它是端到端加密的根，必须一起传过去');
  if (config.kind === 'webdav' && config.url.trim() === '') throw new Error('还没有填远端地址');
  if (config.kind === 's3' && (config.s3Endpoint.trim() === '' || config.s3Bucket.trim() === '')) {
    throw new Error('还没有填 S3 端点或桶名');
  }

  const now = input.now ?? Date.now();
  const payload: JoinPayload = {
    v: 1,
    kind: config.kind === 'webdav' ? 'webdav' : config.kind === 's3' ? 's3' : 'folder',
    ...(config.kind === 'webdav'
      ? {
          url: config.url.trim(),
          ...(config.username === '' ? {} : { username: config.username }),
          ...(config.password === '' ? {} : { password: config.password }),
        }
      : {}),
    ...(config.kind === 'folder' ? { folder: config.folder } : {}),
    ...(config.kind === 's3'
      ? {
          endpoint: config.s3Endpoint.trim(),
          bucket: config.s3Bucket.trim(),
          region: config.s3Region.trim(),
          accessKeyId: config.s3AccessKeyId.trim(),
          ...(config.s3SecretAccessKey === '' ? {} : { s3SecretAccessKey: config.s3SecretAccessKey }),
        }
      : {}),
    secret: config.secret,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    nonce: input.nonce ?? Math.random().toString(36).slice(2, 12),
  };

  const body = toBase64Url(JSON.stringify(payload));
  return {
    link: `${SYNC_JOIN_SCHEME}?v=1&c=${checksumOf(body)}&p=${body}`,
    expiresAt: payload.expiresAt,
  };
}

/** 解析对方给的链接。任何一项不对劲都明确失败 —— 静默接受半截配置比报错更糟。 */
export function decodeJoinLink(text: string, options: { now?: number } = {}): JoinLinkParseResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith(`${SYNC_JOIN_SCHEME}?`)) return { ok: false, error: '不是 Story Lantern 配对链接' };

  const params = new URLSearchParams(trimmed.slice(SYNC_JOIN_SCHEME.length + 1));
  if (params.get('v') !== '1') return { ok: false, error: `不支持的配对版本：${params.get('v') ?? '(缺失)'}` };
  const body = params.get('p');
  if (body === null || body === '') return { ok: false, error: '配对内容缺失' };
  const checksum = params.get('c');
  if (checksum !== checksumOf(body)) return { ok: false, error: '配对链接不完整（校验和不符，可能被截断或抄错）' };

  let payload: JoinPayload;
  try {
    payload = JSON.parse(fromBase64Url(body)) as JoinPayload;
  } catch (error) {
    return { ok: false, error: `配对内容解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '配对内容不是对象' };
  if (payload.kind !== 'webdav' && payload.kind !== 'folder' && payload.kind !== 's3') {
    return { ok: false, error: `不认识的同步方式：${String(payload.kind)}` };
  }
  if (typeof payload.secret !== 'string' || payload.secret === '') return { ok: false, error: '配对内容里没有同步口令' };
  if (typeof payload.expiresAt !== 'number') return { ok: false, error: '配对内容缺少有效期' };
  if (payload.kind === 'webdav' && (payload.url ?? '') === '') return { ok: false, error: '配对内容里没有远端地址' };
  if (payload.kind === 's3' && ((payload.endpoint ?? '') === '' || (payload.bucket ?? '') === '')) {
    return { ok: false, error: '配对内容里缺少 S3 端点或桶名' };
  }

  const now = options.now ?? Date.now();
  if (payload.expiresAt <= now) return { ok: false, error: '配对链接已过期，请让对方重新生成' };

  return { ok: true, payload };
}

/**
 * 把解析出来的载荷摊成"要写进设置的非机密键值"与"要写进设备本地 kv 的机密"。
 *
 * 分开的原因与同步口令一样：宿主对 secret 类设置键只回掩码，写回去会把真值覆盖掉。
 */
export function joinLinkWrites(payload: JoinPayload): {
  settings: Record<string, string>;
  secrets: { secret: string; s3SecretAccessKey?: string };
} {
  const settings: Record<string, string> = { 'sync.kind': payload.kind };
  if (payload.kind === 'webdav') {
    settings['sync.url'] = payload.url ?? '';
    settings['sync.username'] = payload.username ?? '';
    settings['sync.password'] = payload.password ?? '';
  }
  if (payload.kind === 'folder') settings['sync.folder'] = payload.folder ?? '';
  if (payload.kind === 's3') {
    settings['sync.s3.endpoint'] = payload.endpoint ?? '';
    settings['sync.s3.bucket'] = payload.bucket ?? '';
    settings['sync.s3.region'] = payload.region ?? '';
    settings['sync.s3.accessKeyId'] = payload.accessKeyId ?? '';
  }
  return {
    settings,
    secrets: {
      secret: payload.secret,
      ...(payload.s3SecretAccessKey === undefined ? {} : { s3SecretAccessKey: payload.s3SecretAccessKey }),
    },
  };
}
