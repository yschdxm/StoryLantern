import type { DeviceStore } from '../op-ports.ts';
import { toHex, type SignerPort, type SigningAlgorithm } from '../../../../../packages/sync-core/src/signing.ts';

/**
 * 每台设备的"锁和钥匙"（签名器）。
 *
 * 两种强度，界面必须如实显示：
 *  - **ed25519（强）**：本机生成一对密钥，私钥只存在设备本地；公钥随名单发布。
 *    别人伪造不了本机写的东西，也能确知"这段是谁写的"。
 *  - **hmac-sha256（弱）**：本机拿不到 Ed25519 时的退路。用同步口令派生一把组内密钥，
 *    能证明"来自组内"，但**证明不了是哪台设备**——组内成员之间可以互相冒充。
 *
 * 探测方式：直接尝试生成一把 Ed25519 密钥，失败就说明这个 WebView 不支持（老设备上常见），
 * 而不是靠 UA 猜。
 *
 * 关于私钥的存放：它**明文存在设备本地的 kv 里**（类似 0600 的 SSH 私钥）。
 * 这是有意的取舍——要加密得再有第二把钥匙，而"第二把钥匙放哪"会绕回同一个问题；
 * 本机存储被攻破时，签名与数据本来也都暴露了。这条写进文档，不假装它更安全。
 */

export const SIGNING_KEY_KEY = 'sync.sign.key.v1';

interface StoredKey {
  v: 1;
  algorithm: SigningAlgorithm;
  /** PKCS#8（十六进制）。 */
  privateKey: string;
  /** raw 公钥（十六进制）。 */
  publicKey: string;
}

export async function detectSigningAlgorithm(): Promise<SigningAlgorithm> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return 'hmac-sha256';
  try {
    await subtle.generateKey({ name: 'Ed25519' } as never, true, ['sign', 'verify']);
    return 'ed25519';
  } catch {
    return 'hmac-sha256';
  }
}

export interface DeviceSignerOptions {
  deviceId: string;
  device: DeviceStore;
  /** 同步口令（弱模式用它派生组内密钥）。 */
  secret: string;
}

export interface DeviceSigner {
  port: SignerPort;
  algorithm: SigningAlgorithm;
  /** 强模式才有：随名单发布，别人用它验本机的签。 */
  publicKeyHex: string;
}

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** 弱模式的组内密钥：由同步口令派生，长度固定 32 字节。 */
async function deriveGroupKey(subtle: SubtleCrypto, secret: string): Promise<CryptoKey> {
  const material = new TextEncoder().encode(`storylantern/sign/v1/${secret}`);
  const digest = await subtle.digest('SHA-256', bufferOf(material));
  return subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function loadOrCreateKey(subtle: SubtleCrypto, device: DeviceStore): Promise<StoredKey> {
  const stored = await device.get(SIGNING_KEY_KEY);
  if (stored !== undefined && stored !== '') {
    try {
      const parsed = JSON.parse(stored) as Partial<StoredKey>;
      if (parsed.v === 1 && parsed.algorithm === 'ed25519' && typeof parsed.privateKey === 'string' && typeof parsed.publicKey === 'string') {
        return { v: 1, algorithm: 'ed25519', privateKey: parsed.privateKey, publicKey: parsed.publicKey };
      }
    } catch {
      // 坏数据按"还没有密钥"处理：重新生成一把（旧签名会验不过，这是正确行为）
    }
  }

  const pair = (await subtle.generateKey({ name: 'Ed25519' } as never, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const created: StoredKey = { v: 1, algorithm: 'ed25519', privateKey: toHex(pkcs8), publicKey: toHex(raw) };
  await device.set(SIGNING_KEY_KEY, JSON.stringify(created));
  return created;
}

export async function createDeviceSigner(options: DeviceSignerOptions): Promise<DeviceSigner> {
  const subtle = globalThis.crypto?.subtle;
  const algorithm = await detectSigningAlgorithm();

  if (algorithm === 'ed25519' && subtle !== undefined) {
    const key = await loadOrCreateKey(subtle, options.device);
    const privateKey = await subtle.importKey(
      'pkcs8',
      bufferOf(bytesFromHex(key.privateKey)),
      { name: 'Ed25519' } as never,
      false,
      ['sign'],
    );
    // 公钥每次现导入现用：验签要的是**对方**的公钥，所以这里只导出本机那一把
    let cachedPublic: Uint8Array | undefined;
    const publicBytes = (): Uint8Array => {
      cachedPublic ??= bytesFromHex(key.publicKey);
      return cachedPublic;
    };

    const port: SignerPort = {
      algorithm: 'ed25519',
      deviceId: options.deviceId,
      publicKeyHex: key.publicKey,
      async sign(message) {
        return new Uint8Array(await subtle.sign({ name: 'Ed25519' } as never, privateKey, bufferOf(message)));
      },
      /** 用**被声称那台设备**的公钥验签（不是拿自己的再签一遍）。 */
      async verify(publicKeyHex, message, signature) {
        if (publicKeyHex === '') return false;
        const imported = await subtle.importKey(
          'raw',
          bufferOf(bytesFromHex(publicKeyHex)),
          { name: 'Ed25519' } as never,
          false,
          ['verify'],
        );
        return subtle.verify({ name: 'Ed25519' } as never, imported, bufferOf(signature), bufferOf(message));
      },
    };
    // 本机公钥必须能被读到（发布名单时要用）
    void publicBytes();
    return { port, algorithm: 'ed25519', publicKeyHex: key.publicKey };
  }

  // 弱模式：组内共享密钥。能防组外伪造，防不了组内冒充。
  if (subtle === undefined) {
    throw new Error('这个环境没有 WebCrypto，无法签名');
  }
  const groupKey = await deriveGroupKey(subtle, options.secret);
  const port: SignerPort = {
    algorithm: 'hmac-sha256',
    deviceId: options.deviceId,
    publicKeyHex: '',
    async sign(message) {
      return new Uint8Array(await subtle.sign('HMAC', groupKey, bufferOf(message)));
    },
    async verify(_publicKeyHex, message, signature) {
      return subtle.verify('HMAC', groupKey, bufferOf(signature), bufferOf(message));
    },
  };
  return { port, algorithm: 'hmac-sha256', publicKeyHex: '' };
}
