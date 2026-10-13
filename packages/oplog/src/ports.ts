/**
 * 端口：oplog 核心（编解码、打包、重放）不直接依赖 Node 或浏览器 API。
 * 所有平台能力都从这里注入，因此同一份协议代码可以跑在 Node、WebView 和 Tauri 原生侧。
 */

export interface Digest {
  /** 内容摘要（段名与签名都基于它）。 */
  sha256(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** 盲化路径片段用。 */
  hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface Compressor {
  readonly algorithm: string;
  compress(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  decompress(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** 段级签名者：每台设备一把私钥，签名覆盖段的规范元组。 */
export interface SegmentSigner {
  readonly deviceId: string;
  sign(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/**
 * 段级验签器：只接受「设备名单」内的公钥。
 * 这一条是哑存储能被信任的前提——存储方即使有写权限，也伪造不出别的设备的内容。
 */
export interface SignatureVerifier {
  verify(deviceId: string, data: Uint8Array, signature: Uint8Array): boolean | Promise<boolean>;
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
  signer?: SegmentSigner;
  verifier?: SignatureVerifier;
  cipher?: SegmentCipher;
}
