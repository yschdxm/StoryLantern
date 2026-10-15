import type { KeyWrapPort } from '../../../../../packages/sync-core/src/keyring.ts';
import { toHex } from '../../../../../packages/sync-core/src/signing.ts';
import type { DeviceStore } from '../op-ports.ts';

/**
 * "一人一把锁"的 WebCrypto 实现（**ECDH P-256** + HKDF-SHA256 + AES-GCM）。
 *
 * 为什么最后是 P-256（这是真机踩出来的更正）：
 *  - 最早用的是 **X25519**，但实测**真机 WebView（Chrome）不提供 WebCrypto X25519**，
 *    于是"加入共享目录 / 替新设备发钥匙"在真机上根本走不通（只有较新的模拟器 WebView 可以）；
 *  - **P-256** 是 WebCrypto 全平台都支持的椭圆曲线（Chrome / WebView / Safari 都有），
 *    所以新记录一律用它；
 *  - **旧记录仍要能读**：早期用 X25519 包出来的钥匙包还在，别人的旧公钥（32 字节）也还在名单里，
 *    所以这里**按公钥长度选曲线**：P-256 公钥 65 字节（130 个十六进制字符），X25519 是 32 字节（64 个）。
 *    解包时无法先从密文看出用哪条曲线，就**两种都试**（AES-GCM 有认证，试错只会失败、不会解出垃圾）。
 *
 * HKDF-SHA256 把 ECDH 出来的共享秘密整理成一把 AES 密钥（不直接用共享秘密）；
 * AES-GCM 包装内容密钥时带认证（别人解不出**也改不了**）。
 * 包的时候把**双方公钥排序**后混进 HKDF 的 salt：ECDH 双方都能算共享秘密，
 * 绑上公钥可以避免"换个人名就能互相顶替"这类错用，也顺带让两条曲线互不干扰。
 */

export type WrapCurve = 'P-256' | 'X25519';

/** 曲线参数：公钥长度不同，算法名也不同（X25519 在 WebCrypto 里是独立算法）。 */
const CURVES: Record<WrapCurve, { algorithm: Record<string, unknown>; publicKeyBytes: number }> = {
  'P-256': { algorithm: { name: 'ECDH', namedCurve: 'P-256' }, publicKeyBytes: 65 },
  X25519: { algorithm: { name: 'X25519' }, publicKeyBytes: 32 },
};

/**
 * 按公钥十六进制长度判断它属于哪条曲线。
 *
 * P-256 的 raw 公钥是 `04 || X || Y` 共 65 字节 → 130 个字符；X25519 是 32 字节 → 64 个字符。
 */
export function curveOfPublicKey(publicKeyHex: string): WrapCurve {
  return publicKeyHex.length >= CURVES['P-256'].publicKeyBytes * 2 ? 'P-256' : 'X25519';
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function bytesFromHex(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error(`不是合法的十六进制公钥：${hex.slice(0, 16)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return out;
}

/**
 * 本机能不能包/解钥匙。
 *
 * 检的是 **P-256**（不是 X25519）：真机 Chrome 没有 X25519，但一定有 P-256。
 */
export async function detectKeyWrapSupport(): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return false;
  try {
    await subtle.generateKey(CURVES['P-256'].algorithm as never, true, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

export function createWebCryptoKeyWrap(): KeyWrapPort {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('这个环境没有 WebCrypto，无法包装密钥');

  async function generatePair(curve: WrapCurve): Promise<CryptoKeyPair> {
    return (await subtle.generateKey(CURVES[curve].algorithm as never, true, ['deriveBits'])) as CryptoKeyPair;
  }

  /**
   * 这台设备的 WebView 认不认识这条曲线。
   *
   * 真机踩过：给**旧 X25519 对端**包钥匙时，真机 WebView 会直接抛
   * 「Failed to execute 'generateKey' … Algorithm: Unrecognized name」——用户看不懂，
   * 我们也只想知道"能不能做"。所以先探测，再用人话拒绝。
   */
  async function supportsCurve(curve: WrapCurve): Promise<boolean> {
    try {
      await subtle.generateKey(CURVES[curve].algorithm as never, true, ['deriveBits']);
      return true;
    } catch {
      return false;
    }
  }

  /** ECDH → HKDF → AES-GCM 密钥；salt 与 info 里绑上双方公钥。 */
  async function deriveAesKey(
    myPrivate: CryptoKey,
    peerPublic: CryptoKey,
    curve: WrapCurve,
    peerPublicHex: string,
    myPublicHex: string,
  ): Promise<CryptoKey> {
    const algorithm = { ...CURVES[curve].algorithm, public: peerPublic };
    const shared = await subtle.deriveBits(algorithm as never, myPrivate, 256);
    const hkdfKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    // 两个公钥**排序**后拼进 salt：包装方与解包方拿到的顺序可能相反，不排序就对不上
    const pair = [myPublicHex, peerPublicHex].sort().join('/');
    const salt = new TextEncoder().encode(`storylantern/keywrap/v1/${pair}`);
    const info = new TextEncoder().encode('storylantern/content-key/v1');
    const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256);
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function importPublic(hex: string, curve: WrapCurve): Promise<CryptoKey> {
    return subtle.importKey('raw', bufferOf(bytesFromHex(hex)), CURVES[curve].algorithm as never, false, []);
  }

  async function unwrapOnCurve(
    curve: WrapCurve,
    myPrivateKey: string,
    myPublicKeyHex: string,
    combined: Uint8Array,
  ): Promise<Uint8Array> {
    const size = CURVES[curve].publicKeyBytes;
    if (combined.length <= size + 12) throw new Error('包起来的钥匙长度不对');
    const ephemeralPublic = combined.slice(0, size);
    const iv = combined.slice(size, size + 12);
    const sealed = combined.slice(size + 12);

    const privateKey = await subtle.importKey(
      'pkcs8',
      bufferOf(bytesFromHex(myPrivateKey)),
      CURVES[curve].algorithm as never,
      false,
      ['deriveBits'],
    );
    const peer = await importPublic(toHex(ephemeralPublic), curve);
    const aes = await deriveAesKey(privateKey, peer, curve, toHex(ephemeralPublic), myPublicKeyHex);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv } as never, aes, bufferOf(sealed));
    return new Uint8Array(plain);
  }

  return {
    async generateAgreementKeys() {
      // 新设备一律 P-256，这样真机也能加入
      const pair = await generatePair('P-256');
      const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      const privateKey = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
      // 公钥要以十六进制发布；私钥留给本机存（与签名私钥一样的取舍：明文存本地，写进文档）
      return { publicKey: toHex(publicKey), privateKey: toHex(privateKey) };
    },

    async randomContentKey() {
      return new Uint8Array(crypto.getRandomValues(new Uint8Array(32)));
    },

    async wrapFor(recipientPublicKeyHex, contentKey) {
      // 按**收件人**公钥选曲线：给他用他自己那把锁对应的曲线，新旧对端都能收到钥匙
      const curve = curveOfPublicKey(recipientPublicKeyHex);
      if (!(await supportsCurve(curve))) {
        throw new Error(
          `这台设备的 WebView 不认识 ${curve} 这条曲线，没法给这个对端（${recipientPublicKeyHex.slice(0, 8)}…）包钥匙：` +
            '请让支持它的设备（例如较新的 WebView）来做建库/换代。',
        );
      }
      // 包装方临时生成一对密钥：只需要对方公钥就能包（离线也能包）
      const ephemeral = await generatePair(curve);
      const ephemeralPublic = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
      const peer = await importPublic(recipientPublicKeyHex, curve);
      const aes = await deriveAesKey(ephemeral.privateKey, peer, curve, recipientPublicKeyHex, toHex(ephemeralPublic));

      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(
        await subtle.encrypt({ name: 'AES-GCM', iv } as never, aes, bufferOf(contentKey)),
      );
      // 格式：临时公钥 | iv | 密文（都塞进一个 base64 里，读的人按长度切）
      const combined = new Uint8Array(ephemeralPublic.length + iv.length + sealed.length);
      combined.set(ephemeralPublic, 0);
      combined.set(iv, ephemeralPublic.length);
      combined.set(sealed, ephemeralPublic.length + iv.length);
      let binary = '';
      for (const byte of combined) binary += String.fromCharCode(byte);
      return btoa(binary);
    },

    async unwrapWith(myPrivateKey, myPublicKeyHex, wrapped) {
      const binary = atob(wrapped);
      const combined = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) combined[index] = binary.charCodeAt(index);

      // 密文里看不出用的是哪条曲线：按公钥长度先试"自己那把"对应的曲线，再试另一种（认证失败只会抛错）
      const mine = curveOfPublicKey(myPublicKeyHex);
      const order: WrapCurve[] = mine === 'P-256' ? ['P-256', 'X25519'] : ['X25519', 'P-256'];
      let firstError: unknown;
      for (const curve of order) {
        try {
          return await unwrapOnCurve(curve, myPrivateKey, myPublicKeyHex, combined);
        } catch (cause) {
          if (firstError === undefined) firstError = cause;
        }
      }
      throw firstError instanceof Error ? firstError : new Error('这份钥匙包解不开（曲线不匹配或密钥不对）');
    },
  };
}

/** 本机协商密钥对在设备本地 kv 里的键（值里可能是 P-256，也可能是早期生成的 X25519）。 */
export const AGREEMENT_KEY_KEY = 'sync.agree.key.v1';

/**
 * 取（或第一次生成）本机的协商密钥对。
 *
 * 公私钥一起存：解包时 HKDF 的 salt 绑了双方公钥，而浏览器里**不能**从私钥导出公钥。
 * 与签名私钥一样是明文存本地（类似 0600 的 SSH 私钥），这条取舍写进文档，不假装更安全。
 *
 * 已经存过的旧密钥（X25519）**不换**：库主人还要用它解自己那份钥匙，
 * 而给新设备包钥匙是按**对方**公钥选曲线的，所以不需要给已有设备重新配钥匙。
 */
export async function loadOrCreateAgreementKeys(
  port: KeyWrapPort,
  device: DeviceStore,
): Promise<{ publicKey: string; privateKey: string }> {
  const stored = await device.get(AGREEMENT_KEY_KEY);
  if (stored !== undefined && stored !== '') {
    try {
      const parsed = JSON.parse(stored) as { v?: number; publicKey?: string; privateKey?: string };
      if (parsed.v === 1 && typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string' && parsed.publicKey !== '') {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
      }
    } catch {
      // 坏数据按"还没有密钥"处理：重新生成一把（旧的包再也解不开，这是正确行为）
    }
  }
  const created = await port.generateAgreementKeys();
  await device.set(AGREEMENT_KEY_KEY, JSON.stringify({ v: 1, ...created }));
  return created;
}
