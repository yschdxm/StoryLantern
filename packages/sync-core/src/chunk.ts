import type { Op } from '../../oplog/src/op.ts';
import { estimateOpBytes, SEGMENT_POLICY, shouldFlush } from '../../oplog/src/segment.ts';

/**
 * 把待发布的 op 切成段。
 *
 * 段大小必须有上界：太大 → 一次重传代价高、失败窗口长；太小 → 文件数与往返数暴涨。
 * 目标区间见 `SEGMENT_POLICY`（256 KB–1 MB，或 1500 条 op）。
 */
export function chunkOps(ops: readonly Op[]): Op[][] {
  const chunks: Op[][] = [];
  let current: Op[] = [];
  let bytes = 0;

  for (const op of ops) {
    current.push(op);
    bytes += estimateOpBytes(op);
    if (shouldFlush(bytes, current.length)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 估算一批 op 的原始字节数（用于容量报告与预算断言）。 */
export function estimateBatchBytes(ops: readonly Op[]): number {
  return ops.reduce((sum, op) => sum + estimateOpBytes(op), 0);
}

export { SEGMENT_POLICY };
