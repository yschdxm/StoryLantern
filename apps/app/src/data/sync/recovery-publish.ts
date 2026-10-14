import type { SyncBackend } from '../../../../../packages/sync-core/src/backend.ts';
import { RECOVERY_FILE, serializeRecoveryFile, type RecoveryFile } from '../../../../../packages/sync-core/src/recovery.ts';
import { createWebCryptoRecoveryProof } from './recovery-key.ts';

/**
 * 生成恢复密钥并把**公钥**发布到共享目录。
 *
 * 私钥**只返回给用户一次**：这里刻意不保存（落地就等于「离线保存」没意义）。
 * 界面必须写清「丢了只能重新生成并重新公布公钥」。
 */
export async function publishRecoveryKey(
  backend: SyncBackend,
  createdAt: number,
): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await createWebCryptoRecoveryProof().generate();
  const file: RecoveryFile = { v: 1, publicKey: pair.publicKey, createdAt };
  await backend.put(RECOVERY_FILE, new TextEncoder().encode(serializeRecoveryFile(file)));
  return pair;
}
