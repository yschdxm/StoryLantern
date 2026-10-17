import type { KeyWrapPort } from '../../../../../packages/sync-core/src/keyring.ts';
import { toHex } from '../../../../../packages/oplog/src/bytes.ts';
import type { DeviceStore } from '../op-ports.ts';

/**
 * "一人一把锁"的 WebCrypto 实现（**ECDH P-256** + HKDF-SHA256 + AES-GCM）。
 *
 * 为什么是 P-256，以及**为什么旧曲线（X25519）的实现已经删掉**：
 *  - 最早用的是 X25519，但实测**真机 WebView（Chrome）不提供 WebCrypto X25519**，
 *    于是"加入共享目录 / 替新设备发钥匙"在真机上根本走不通（只有较新的模拟器 WebView 可以）；
 *  - **P-256** 是 WebCrypto 全平台都支持的椭圆曲线（Chrome / WebView / Safari 都有），所以一律用它；
 *  - 早期版本曾保留 X25519 的读写分支以便"旧记录仍能读"。**现已删除**，依据是实测：
 *    应用未发布（0.0.1，个人项目）、线上不存在 X25519 包出来的钥匙包（现网 keyring.json 里只有 P-256 的
 *    一条 entry），而真机上唯一的旧曲线残留是**名单里某个对端的公钥**——那只需要"按长度认出来并拒绝"，
 *    不需要保留整套 X25519 加解密（见 DEVELOPMENT.md 第六十三节）。
 *  - 所以现在只有一件事要知道：**公钥是 65 字节（P-256）还是 32 字节（旧曲线）**；
 *    遇到旧曲线一律走"跳过 + 明确提示重新配对"，而不是"两种都试"。
 *
 * HKDF-SHA256 把 ECDH 出来的共享秘密整理成一把 AES 密钥（不直接用共享秘密）；
 * AES-GCM 包装内容密钥时带认证（别人解不出**也改不了**）。
 * 包的时候把**双方公钥排序**后混进 HKDF 的 salt：ECDH 双方都能算共享秘密，
 * 绑上公钥可以避免"换个人名就能互相顶替"这类错用。
 */

/** 只支持 P-256；`legacy` = 旧曲线（32 字节公钥），本版本不再实现，只能识别并拒绝。 */
export type PublicKeyCurve = 'P-256' | 'legacy';

/** P-256 的 raw 公钥是 `04 || X || Y` 共 65 字节 → 130 个十六进制字符；旧曲线是 32 字节 → 64 个。 */
const P256_PUBLIC_KEY_BYTES = 65;
const P256_ALGORITHM = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** 按公钥十六进制长度判断它是不是 P-256（短的那些就是已淘汰的旧曲线）。 */
export function curveOfPublicKey(publicKeyHex: string): PublicKeyCurve {
  return publicKeyHex.length >= P256_PUBLIC_KEY_BYTES * 2 ? 'P-256' : 'legacy';
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
 * 本机能不能包/解钥匙（检的是 P-256）。真机 Chrome 没有 X25519，但一定有 P-256。
 */
export async function detectKeyWrapSupport(): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return false;
  try {
    await subtle.generateKey(P256_ALGORITHM as never, true, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

export function createWebCryptoKeyWrap(): KeyWrapPort {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('这个环境没有 WebCrypto，无法包装密钥');

  async function generatePair(): Promise<CryptoKeyPair> {
    return (await subtle.generateKey(P256_ALGORITHM as never, true, ['deriveBits'])) as CryptoKeyPair;
  }

  /** ECDH → HKDF → AES-GCM 密钥；salt 与 info 里绑上双方公钥。 */
  async function deriveAesKey(
    myPrivate: CryptoKey,
    peerPublic: CryptoKey,
    peerPublicHex: string,
    myPublicHex: string,
  ): Promise<CryptoKey> {
    const shared = await subtle.deriveBits(
      { ...P256_ALGORITHM, public: peerPublic } as never,
      myPrivate,
      256,
    );
    const hkdfKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    // 两个公钥**排序**后拼进 salt：包装方与解包方拿到的顺序可能相反，不排序就对不上
    const pair = [myPublicHex, peerPublicHex].sort().join('/');
    const salt = new TextEncoder().encode(`storylantern/keywrap/v1/${pair}`);
    const info = new TextEncoder().encode('storylantern/content-key/v1');
    const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256);
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  async function importPublic(hex: string): Promise<CryptoKey> {
    return subtle.importKey('raw', bufferOf(bytesFromHex(hex)), P256_ALGORITHM as never, false, []);
  }

  return {
    async generateAgreementKeys() {
      const pair = await generatePair();
      const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
      const privateKey = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
      // 公钥要以十六进制发布；私钥留给本机存（与签名私钥一样的取舍：明文存本地，写进文档）
      return { publicKey: toHex(publicKey), privateKey: toHex(privateKey) };
    },

    async randomContentKey() {
      return new Uint8Array(crypto.getRandomValues(new Uint8Array(32)));
    },

    async wrapFor(recipientPublicKeyHex, contentKey) {
      // 旧曲线的对端：**明确拒绝**，不再"两种都试"（那套 X25519 实现已删除）
      if (curveOfPublicKey(recipientPublicKeyHex) !== 'P-256') {
        throw new Error(
          `这个对端（${recipientPublicKeyHex.slice(0, 8)}…）用的是已淘汰的旧曲线（32 字节公钥），本版本不再支持：` +
            '请让它重新配对（新配对的设备一律用 P-256；旧设备仍能读它以前拿到过的内容）。',
        );
      }
      // 本机没有 P-256 能力（极老的 WebView）：也要给人话，而不是把底层的 Unrecognized name 抛给用户
      if (!(await detectKeyWrapSupport())) {
        throw new Error('这台设备没有可用的 P-256 密钥协商能力，没法包装数据钥匙：请在较新的浏览器/WebView 里做这一步。');
      }
      // 包装方临时生成一对密钥：只需要对方公钥就能包（离线也能包）
      const ephemeral = await generatePair();
      const ephemeralPublic = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
      const peer = await importPublic(recipientPublicKeyHex);
      const aes = await deriveAesKey(ephemeral.privateKey, peer, recipientPublicKeyHex, toHex(ephemeralPublic));

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

    /**
     * 本机能不能给这个公钥包钥匙：是 P-256 且本机有 P-256 能力。
     *
     * 名单里残留的旧曲线对端在这里回答 false —— 建库/换代据此**跳过并列出来**，
     * 而不是一路抛到用户眼前（那条路以前是硬失败，报错还把责任推给设备）。
     */
    async canWrapFor(recipientPublicKeyHex: string): Promise<boolean> {
      if (curveOfPublicKey(recipientPublicKeyHex) !== 'P-256') return false;
      return detectKeyWrapSupport();
    },

    async unwrapWith(myPrivateKey, myPublicKeyHex, wrapped) {
      const binary = atob(wrapped);
      const combined = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) combined[index] = binary.charCodeAt(index);

      // 只有 P-256 一种可能：旧曲线那份实现已删除（列表里不再"两种都试"）
      if (curveOfPublicKey(myPublicKeyHex) !== 'P-256') {
        throw new Error('这把协商密钥是已淘汰的旧曲线，本版本不再支持：请让它重新配对。');
      }
      const size = P256_PUBLIC_KEY_BYTES;
      if (combined.length <= size + 12) throw new Error('包起来的钥匙长度不对');
      const ephemeralPublic = combined.slice(0, size);
      const iv = combined.slice(size, size + 12);
      const sealed = combined.slice(size + 12);

      const privateKey = await subtle.importKey(
        'pkcs8',
        bufferOf(bytesFromHex(myPrivateKey)),
        P256_ALGORITHM as never,
        false,
        ['deriveBits'],
      );
      const peer = await importPublic(toHex(ephemeralPublic));
      const aes = await deriveAesKey(privateKey, peer, toHex(ephemeralPublic), myPublicKeyHex);
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv } as never, aes, bufferOf(sealed));
      return new Uint8Array(plain);
    },
  };
}

/** 本机协商密钥对在设备本地 kv 里的键（值里理论上只可能是 P-256；旧曲线会被换成新的）。 */
export const AGREEMENT_KEY_KEY = 'sync.agree.key.v1';

/**
 * 取（或第一次生成）本机的协商密钥对。
 *
 * 公私钥一起存：解包时 HKDF 的 salt 绑了双方公钥，而浏览器里**不能**从私钥导出公钥。
 * 与签名私钥一样是明文存本地（类似 0600 的 SSH 私钥），这条取舍写进文档，不假装更安全。
 *
 * **只认 P-256**：存着旧曲线（X25519）的密钥时一律重新生成 —— 旧曲线实现已删除，
 * 留着它只会让本机永远解不开钥匙包（真机上表现为同步反复重跑）。即使本机"有能力"用 X25519 也不复用，
 * 否则这种设备的密钥永远停在旧曲线上，X25519 就永远删不干净。
 */
export async function loadOrCreateAgreementKeys(
  port: KeyWrapPort,
  device: DeviceStore,
): Promise<{ publicKey: string; privateKey: string }> {
  const stored = await device.get(AGREEMENT_KEY_KEY);
  if (stored !== undefined && stored !== '') {
    try {
      const parsed = JSON.parse(stored) as { v?: number; publicKey?: string; privateKey?: string };
      if (
        parsed.v === 1 &&
        typeof parsed.publicKey === 'string' &&
        typeof parsed.privateKey === 'string' &&
        parsed.publicKey !== '' &&
        curveOfPublicKey(parsed.publicKey) === 'P-256' &&
        (await detectKeyWrapSupport())
      ) {
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
