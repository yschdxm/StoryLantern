import { toHex } from '../../oplog/src/bytes.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import { validateSessionSnapshot, type SessionSnapshot } from '../../oplog/src/snapshot.ts';
import { decodeEnvelope, encodeEnvelope } from './envelope.ts';
import { parseInnerJson } from './manifest.ts';
import { snapshotPath } from './paths.ts';

export interface EncodedSnapshot {
  path: string;
  bytes: Uint8Array;
  hash: string;
}

export async function encodeSessionSnapshot(
  snapshot: SessionSnapshot,
  options: { ports: CryptoPorts; encrypt?: boolean; format?: 1 | 2 },
): Promise<EncodedSnapshot> {
  const inner = JSON.stringify(snapshot);
  const bytes = await encodeEnvelope(inner, {
    ports: options.ports,
    encrypt: options.encrypt === true,
    // AAD 绑定到会话：把密文搬到另一个会话目录后解密必然失败。
    aad: `snapshot|${snapshot.blindSessionId}`,
    ...(options.format === undefined ? {} : { format: options.format }),
  });
  const hash = toHex(await options.ports.digest.sha256(bytes));
  return { path: snapshotPath(snapshot.blindSessionId, hash), bytes, hash };
}

export interface DecodeSnapshotOptions {
  ports: CryptoPorts;
  expect: { blindSessionId: string; deviceId?: string };
}

export async function decodeSessionSnapshot(bytes: Uint8Array, options: DecodeSnapshotOptions): Promise<SessionSnapshot> {
  const { ports, expect } = options;
  const { inner } = await decodeEnvelope(bytes, {
    ports,
    aad: `snapshot|${expect.blindSessionId}`,
  });

  // 旧快照里可能有已删除的签名字段：validateSessionSnapshot 不看未知字段，直接忽略。
  const snapshot = validateSessionSnapshot(parseInnerJson(inner, 'snapshot'));
  if (snapshot.blindSessionId !== expect.blindSessionId) {
    throw new Error(`快照归属会话 ${snapshot.blindSessionId} 与预期 ${expect.blindSessionId} 不符`);
  }
  if (expect.deviceId !== undefined && snapshot.deviceId !== expect.deviceId) {
    throw new Error(`快照归属设备 ${snapshot.deviceId} 与预期 ${expect.deviceId} 不符`);
  }

  return snapshot;
}
