/**
 * 端口：oplog 核心（编解码、打包、重放）不直接依赖 Node 或浏览器 API。
 * 所有平台能力都从这里注入，因此同一份协议代码可以跑在 Node、WebView 和 Tauri 原生侧。
 */

export interface Digest {
  /** 内容摘要（段名与完整性校验都基于它）。 */
  sha256(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** 盲化路径片段用。 */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface Compressor {
  readonly algorithm: string;
  compress(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  decompress(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface SealedPayload {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * 段内容加密。实现必须满足：错误密钥/被篡改的密文在 `open` 时抛错，
 * 绝不返回部分明文。
 */
export interface SegmentCipher {
  readonly algorithm: string;
  seal(plaintext: Uint8Array, aad: Uint8Array): SealedPayload | Promise<SealedPayload>;
  open(nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface CryptoPorts {
  digest: Digest;
  compressor: Compressor;
  cipher?: SegmentCipher;
}
