import { fromUtf8, toHex, utf8 } from '../../oplog/src/bytes.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import { decodeEnvelope, encodeEnvelope, verifyEnvelope } from './envelope.ts';
import { manifestFileName } from './paths.ts';

export interface SessionRef {
  blindSessionId: string;
  /** 该设备为这个会话发布的最高段序号。 */
  lastSeq: number;
  /** seq -> hash8：发现缺失段所需的最小索引（因此不需要 list `logs/**`）。 */
  segments: Record<string, string>;
  epoch: number;
  bytes: number;
  /** 该会话可用的快照（换机/首次同步时先拉它，再拉尾巴）。 */
  snapshot?: {
    hash: string;
    epoch: number;
    watermarks: Record<string, number>;
    bytes: number;
  };
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
  /**
   * 旧字段：更早的协议在设备清单里发布"签名公钥"。
   *
   * app 不再注入签名实现（真机 WebView 没有可用的非对称签名，信任模型改为
   * "共享口令 + AES-GCM"），因此**不再写入**；读到旧清单时忽略即可。
   */
  publicKey?: string;
  /**
   * 本机的 P-256 协商公钥（十六进制）：**收自己那份内容密钥**要用它。
   */
  agreementKey?: string;
}

export interface EncodedManifest {
  fileName: string;
  bytes: Uint8Array;
  blobHash: string;
}

export interface EncodeManifestOptions {
  ports: CryptoPorts;
  encrypt?: boolean;
  /** 写哪种信封格式：默认 2；1 只用于"造老文件验证双读"与迁移期。 */
  format?: 1 | 2;
}

/** 签名覆盖的元组：绑定设备、序号与内容哈希。 */
export function manifestSignaturePayload(manifest: Pick<Manifest, 'deviceId' | 'seq'>, contentHash: string): string {
  return ['manifest', manifest.deviceId, String(manifest.seq), contentHash].join('|');
}

export async function encodeManifest(manifest: Manifest, options: EncodeManifestOptions): Promise<EncodedManifest> {
  const { ports } = options;
  const inner = JSON.stringify(manifest);

  const bytes = await encodeEnvelope(inner, {
    ports,
    encrypt: options.encrypt === true,
    aad: `manifest|${manifest.deviceId}`,
    sign: (contentHash) => manifestSignaturePayload(manifest, contentHash),
    ...(options.format === undefined ? {} : { format: options.format }),
  });

  const blobHash = toHex(await ports.digest.sha256(bytes));
  return { fileName: manifestFileName(manifest.seq, blobHash), bytes, blobHash };
}

export interface DecodeManifestOptions {
  ports: CryptoPorts;
  /** 只接受该设备的 manifest（同时用作加密 AAD）。 */
  expectDeviceId: string;
  requireSignature?: boolean;
}

export async function decodeManifest(bytes: Uint8Array, options: DecodeManifestOptions): Promise<Manifest> {
  const { ports, expectDeviceId } = options;
  const { inner, envelope, contentHash } = await decodeEnvelope(bytes, {
    ports,
    aad: `manifest|${expectDeviceId}`,
  });

  const manifest = JSON.parse(inner) as Manifest;
  if (typeof manifest.deviceId !== 'string' || typeof manifest.seq !== 'number') {
    throw new Error('manifest 缺少 deviceId/seq');
  }
  if (manifest.deviceId !== expectDeviceId) {
    throw new Error(`manifest 归属设备 ${manifest.deviceId} 与预期 ${expectDeviceId} 不符`);
  }

  await verifyEnvelope(envelope, {
    ports,
    contentHash,
    payload: manifestSignaturePayload(manifest, contentHash),
    signerDeviceId: manifest.deviceId,
    ...(options.requireSignature === undefined ? {} : { requireSignature: options.requireSignature }),
  });

  manifest.sessions ??= {};
  manifest.ack ??= {};
  return manifest;
}

/** 把本地产生的 op 归入它所属的会话（设置类 op 归入全局伪会话）。 */
export const GLOBAL_SESSION = '__global__';

export function sessionIdOf(op: { type: string; entity: { type: string; id: string }; payload: unknown }): string {
  const payload = op.payload as { sessionId?: string };
  if (typeof payload.sessionId === 'string') return payload.sessionId;
  if (op.entity.type === 'session') return op.entity.id;
  return GLOBAL_SESSION;
}

/** 解码辅助：把信封内容当 JSON 读（snapshot 用）。 */
export function parseInnerJson<T>(inner: string, label: string): T {
  try {
    return JSON.parse(inner) as T;
  } catch (error) {
    throw new Error(`${label} 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

export { fromUtf8, utf8 };

