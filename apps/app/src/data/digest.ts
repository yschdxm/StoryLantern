import { DataError } from './repository.ts';

/**
 * 浏览器/WebView 里可用的 SHA-256（十六进制）。
 *
 * 为什么不用 Node 的实现：前端产物里不许出现 `node:`（有门禁盯着），而设备上跑的就是 WebView。
 * 摘要只用于**内容指纹**（判断"下层内容变没变"），不做安全用途，但既然 WebCrypto 就有，
 * 就没必要自己糊一个弱哈希。
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new DataError('no-host', '当前环境没有 WebCrypto，无法计算内容指纹');
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 分层摘要的指纹函数：多段文本按行拼接后取 SHA-256（与计划器/执行器必须共用同一个）。 */
export async function summaryHash(parts: readonly string[]): Promise<string> {
  return sha256Hex(parts.join('\n'));
}
