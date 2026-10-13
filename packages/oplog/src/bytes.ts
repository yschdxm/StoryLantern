import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

let lastTime = -1;
let lastRandom = 0n;

/** Crockford base32 的 ULID：48 位毫秒时间戳 + 80 位随机，同一毫秒内单调递增。 */
export function ulid(now: number = Date.now()): string {
  let random: bigint;
  if (now === lastTime) {
    random = lastRandom + 1n;
  } else {
    const bytes = randomBytes(10);
    random = 0n;
    for (const byte of bytes) random = (random << 8n) | BigInt(byte);
  }
  lastTime = now;
  lastRandom = random;

  let time = now;
  let timePart = '';
  for (let index = 0; index < 10; index += 1) {
    timePart = ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }

  let value = random;
  let randomPart = '';
  for (let index = 0; index < 16; index += 1) {
    randomPart = ALPHABET[Number(value & 31n)] + randomPart;
    value >>= 5n;
  }

  return timePart + randomPart;
}

/** ULID 字典序 == 时间序（Crockford base32 的字符顺序与数值顺序一致）。 */
export function compareUlid(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isUlid(value: string): boolean {
  if (value.length !== 26) return false;
  for (const ch of value) if (!ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * 盲化标识：把语义 id（会话 id、角色 id）映射成不可逆的路径片段。
 * 目的：远端存储只看到乱码目录名，泄漏不出"这个人在跟谁聊天"。
 *
 * 异步是刻意的：Node 侧是同步 HMAC，浏览器侧将换成 WebCrypto（只有异步 API），
 * 统一成 Promise 可以让同一条代码路径跑在三端。
 */
export async function blindId(
  key: Uint8Array,
  value: string,
  digest: { hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array | Promise<Uint8Array> },
): Promise<string> {
  const mac = await digest.hmacSha256(key, new TextEncoder().encode(value));
  return toHex(mac).slice(0, 32);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`十六进制长度必须为偶数：${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const byte = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`非法十六进制：${hex.slice(index * 2, index * 2 + 2)}`);
    out[index] = byte;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < B64_ALPHABET.length; index += 1) table[B64_ALPHABET.charCodeAt(index)] = index;
  return table;
})();

/** 自带 base64（不依赖 Buffer/btoa），保证 Node、WebView、原生三端行为一致。 */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] as number;
    const b = index + 1 < bytes.length ? (bytes[index + 1] as number) : undefined;
    const c = index + 2 < bytes.length ? (bytes[index + 2] as number) : undefined;

    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64_ALPHABET[c & 0x3f];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (const char of clean) {
    const value = B64_LOOKUP[char.charCodeAt(0)] ?? -1;
    if (value < 0) throw new Error(`非法 base64 字符：'${char}'`);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset] = (buffer >> bits) & 0xff;
      offset += 1;
    }
  }
  return out.subarray(0, offset);
}

/** URL 安全变体（无 padding），用于二维码/URI 这类对字符集敏感的场景。 */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  return fromBase64(remainder === 0 ? padded : padded + '='.repeat(4 - remainder));
}
