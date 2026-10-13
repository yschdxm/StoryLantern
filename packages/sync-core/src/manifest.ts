import { fromBase64, fromUtf8, toBase64, toHex, utf8 } from '../../oplog/src/bytes.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import type { Op } from '../../oplog/src/op.ts';
import { manifestFileName } from './paths.ts';

export interface SessionRef {
  blindSessionId: string;
  /** 该设备为这个会话发布的最高段序号。 */
  lastSeq: number;
  /** seq -> hash8：发现缺失段所需的最小索引（因此不需要 list `logs/**`）。 */
  segments: Record<string, string>;
  epoch: number;
  bytes: number;
}

export interface Manifest {
  v: 1;
  deviceId: string;
  /** manifest 自身的序号，单调递增（每次发布 +1）。 */
  seq: number;
  epoch: number;
  updatedAt: number;
  sessions: Record<string, SessionRef>;
  /** 本设备声明"我已并入 deviceId 的第几号段"，GC 判定依赖它。 */
  ack: Record<string, number>;
}

interface ManifestEnvelope {
  v: 1;
  cipher: string;
  payload?: string;
  nonce?: string;
  ct?: string;
  sig?: string;
}

export interface EncodedManifest {
  fileName: string;
  bytes: Uint8Array;
  blobHash: string;
}

export interface EncodeManifestOptions {
  ports: CryptoPorts;
  encrypt?: boolean;
}

/** 签名覆盖的元组：绑定设备、序号与内容哈希。 */
function manifestSignaturePayload(manifest: Pick<Manifest, 'deviceId' | 'seq'>, contentHash: string): string {
  return ['manifest', manifest.deviceId, String(manifest.seq), contentHash].join('|');
}

export async function encodeManifest(manifest: Manifest, options: EncodeManifestOptions): Promise<EncodedManifest> {
  const { ports } = options;
  const useCipher = options.encrypt === true && ports.cipher !== undefined;
  const cipher = useCipher ? ports.cipher : undefined;

  const inner = JSON.stringify(manifest);
  const contentHash = toHex(await ports.digest.sha256(utf8(inner)));
  const signature = ports.signer ? await ports.signer.sign(utf8(manifestSignaturePayload(manifest, contentHash))) : undefined;

  const envelope: ManifestEnvelope = { v: 1, cipher: cipher?.algorithm ?? 'none' };
  if (cipher) {
    const sealed = await cipher.seal(utf8(inner), utf8(`manifest|${manifest.deviceId}`));
    envelope.nonce = toBase64(sealed.nonce);
    envelope.ct = toBase64(sealed.ciphertext);
  } else {
    envelope.payload = inner;
  }
  if (signature !== undefined) envelope.sig = toBase64(signature);

  const compressed = await ports.compressor.compress(utf8(JSON.stringify(envelope)));
  const blobHash = toHex(await ports.digest.sha256(compressed));
  return { fileName: manifestFileName(manifest.seq, blobHash), bytes: compressed, blobHash };
}

export interface DecodeManifestOptions {
  ports: CryptoPorts;
  /** 只接受名单内设备的 manifest。 */
  expectDeviceId?: string;
  requireSignature?: boolean;
}

export async function decodeManifest(bytes: Uint8Array, options: DecodeManifestOptions): Promise<Manifest> {
  const { ports } = options;
  let envelope: ManifestEnvelope;
  try {
    envelope = JSON.parse(fromUtf8(await ports.compressor.decompress(bytes))) as ManifestEnvelope;
  } catch (error) {
    throw new Error(`manifest 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (envelope.v !== 1) throw new Error(`manifest 版本 ${String(envelope.v)} 不受支持`);

  let inner: string;
  if (envelope.cipher !== 'none') {
    if (!ports.cipher) throw new Error(`manifest 使用 ${envelope.cipher} 加密，当前没有解密实现`);
    if (ports.cipher.algorithm !== envelope.cipher) {
      throw new Error(`manifest 使用 ${envelope.cipher} 加密，当前实现是 ${ports.cipher.algorithm}`);
    }
    const deviceId = options.expectDeviceId ?? 'unknown';
    inner = fromUtf8(
      await ports.cipher.open(fromBase64(envelope.nonce ?? ''), fromBase64(envelope.ct ?? ''), utf8(`manifest|${deviceId}`)),
    );
  } else {
    inner = envelope.payload ?? '';
  }

  const manifest = JSON.parse(inner) as Manifest;
  if (typeof manifest.deviceId !== 'string' || typeof manifest.seq !== 'number') {
    throw new Error('manifest 缺少 deviceId/seq');
  }
  if (options.expectDeviceId !== undefined && manifest.deviceId !== options.expectDeviceId) {
    throw new Error(`manifest 归属设备 ${manifest.deviceId} 与预期 ${options.expectDeviceId} 不符`);
  }

  const contentHash = toHex(await ports.digest.sha256(utf8(inner)));
  if (ports.verifier) {
    if (!envelope.sig) {
      if (options.requireSignature !== false) throw new Error('manifest 缺少签名，拒绝接受');
    } else {
      const ok = await ports.verifier.verify(
        manifest.deviceId,
        utf8(manifestSignaturePayload(manifest, contentHash)),
        fromBase64(envelope.sig),
      );
      if (!ok) throw new Error(`manifest 签名无效（设备 ${manifest.deviceId} 不在名单内或内容被篡改）`);
    }
  }

  manifest.sessions ??= {};
  manifest.ack ??= {};
  return manifest;
}

/** 把本地产生的 op 归入它所属的会话（设置类 op 归入全局伪会话）。 */
export const GLOBAL_SESSION = '__global__';

export function sessionIdOf(op: Op): string {
  const payload = op.payload as { sessionId?: string };
  if (typeof payload.sessionId === 'string') return payload.sessionId;
  if (op.entity.type === 'session') return op.entity.id;
  return GLOBAL_SESSION;
}
