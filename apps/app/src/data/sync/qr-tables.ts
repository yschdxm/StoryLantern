/**
 * QR 里的**标准表**与几何参数（纠错级 L）。
 *
 * 这些数字不是凭记忆写的：分块表、格式信息串、版本信息串都取自 Thonky 的 QR Code Tutorial
 * （对 ISO/IEC 18004 的整理），测试逐字比对；对齐图形的位置则由标准公式算出，并用
 * "v2 → [6,18]、v7 → [6,22,38]"这两个公开例子校对。
 */

/** 纠错级 L 的分块结构：`[每块纠错码字数, 组1块数, 组1每块数据码字, 组2块数, 组2每块数据码字]`。 */
export const L_BLOCKS: Record<number, [number, number, number, number, number]> = {
  1: [7, 1, 19, 0, 0],
  2: [10, 1, 34, 0, 0],
  3: [15, 1, 55, 0, 0],
  4: [20, 1, 80, 0, 0],
  5: [26, 1, 108, 0, 0],
  6: [18, 2, 68, 0, 0],
  7: [20, 2, 78, 0, 0],
  8: [24, 2, 97, 0, 0],
  9: [30, 2, 116, 0, 0],
  10: [18, 2, 68, 2, 69],
  11: [20, 4, 81, 0, 0],
  12: [24, 2, 92, 2, 93],
  13: [26, 4, 107, 0, 0],
  14: [30, 3, 115, 1, 116],
  15: [22, 5, 87, 1, 88],
  16: [24, 5, 98, 1, 99],
  17: [28, 1, 107, 5, 108],
  18: [30, 5, 120, 1, 121],
  19: [28, 3, 113, 4, 114],
  20: [28, 3, 107, 5, 108],
};

export const MAX_VERSION = 20;

/** 纠错级 L、掩码 0..7 的格式信息串（标准里的 8 条）。 */
const FORMAT_L = [
  '111011111000100',
  '111001011110011',
  '111110110101010',
  '111100010011101',
  '110011000101111',
  '110001100011000',
  '110110001000001',
  '110100101110110',
] as const;

/** 版本信息串（v7 起才有）。 */
const VERSION_BITS: Record<number, string> = {
  7: '000111110010010100',
  8: '001000010110111100',
  9: '001001101010011001',
  10: '001010010011010011',
  11: '001011101111110110',
  12: '001100011101100010',
  13: '001101100001000111',
  14: '001110011000001101',
  15: '001111100100101000',
  16: '010000101101111000',
  17: '010001010001011101',
  18: '010010101000010111',
  19: '010011010100110010',
  20: '010100100110100110',
};

export function formatBits(mask: number): string {
  const bits = FORMAT_L[mask];
  if (bits === undefined) throw new Error(`掩码只能是 0..7，收到 ${mask}`);
  return bits;
}

export function versionBits(version: number): string | undefined {
  return VERSION_BITS[version];
}

/** 每版的数据码字总数（来自分块表，供容量判断用）。 */
export function dataCodewordsFor(version: number): number {
  const entry = L_BLOCKS[version];
  if (entry === undefined) throw new Error(`只支持版本 1..${MAX_VERSION}，收到 ${version}`);
  const [, blocks1, data1, blocks2, data2] = entry;
  return blocks1 * data1 + blocks2 * data2;
}

/** 符号边长（模块数）。 */
export function sizeOf(version: number): number {
  return version * 4 + 17;
}

/** 对齐图形中心坐标（v1 没有）。位置按标准公式算，测试用公开例子校对。 */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const size = sizeOf(version);
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((size - 13) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let index = count - 1; index >= 1; index -= 1) positions.push(size - 7 - (count - 1 - index) * step);
  // 从小到大：摆放循环与测试都按这个顺序读（标准里给的也是升序）
  return positions.sort((left, right) => left - right);
}
