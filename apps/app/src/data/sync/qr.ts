import { reedSolomon } from './qr-gf.ts';
import {
  alignmentPositions,
  dataCodewordsFor,
  formatBits,
  L_BLOCKS,
  MAX_VERSION,
  sizeOf,
  versionBits,
} from './qr-tables.ts';

/**
 * 最小 QR 编码器（byte 模式 + 纠错级 L + 版本 1..20 自动选）。
 *
 * 为什么要自己写：零第三方依赖是硬约束，而"配对链接"在手机上最自然的传法是**扫一扫**。
 * 二维码**解码**（相机那条路）仍需要原生能力，这里只解决**显示**这一半。
 *
 * 表与 GF/RS 分别在 `qr-tables.ts` / `qr-gf.ts`（拆开是为了守住"每文件 400 行"这条门禁），
 * 这里再导出一次，调用方只认 `qr.ts` 一个入口。
 *
 * 局限（写明白）：没有独立解码器验证过"真机扫得出来"。若某个模块放错，最坏结果是扫不出来 ——
 * 所以界面上**始终同时给出文本链接**，扫码只是便利，不是唯一通路。
 */

export {
  alignmentPositions,
  dataCodewordsFor,
  formatBits,
  MAX_VERSION,
  sizeOf,
  versionBits,
} from './qr-tables.ts';
export { gfExp, gfMul, generatorPolynomial, reedSolomon } from './qr-gf.ts';

export interface QrCode {
  version: number;
  size: number;
  /** `modules[row][column]`：true = 深色。 */
  modules: boolean[][];
  mask: number;
}

/**
 * 用几何算出的总码字数：先铺功能图形，再数剩下的可用模块。
 *
 * 这是**独立于分块表**的一条信息 —— 测试用它交叉验 `L_BLOCKS`（表若是抄错，两者对不上）。
 */
export function totalCodewordsFor(version: number): number {
  const size = sizeOf(version);
  const reserved = functionPatternMask(version);
  let free = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (reserved[row]?.[column] !== true) free += 1;
    }
  }
  return Math.floor(free / 8);
}

/** 功能图形（探测/分隔/定位/校正/格式/版本）占位表：true = 已被占。 */
function functionPatternMask(version: number): boolean[][] {
  const size = sizeOf(version);
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (row: number, column: number): void => {
    if (row >= 0 && row < size && column >= 0 && column < size) (reserved[row] as boolean[])[column] = true;
  };
  const finder = (top: number, left: number): void => {
    for (let row = -1; row <= 7; row += 1) {
      for (let column = -1; column <= 7; column += 1) mark(top + row, left + column);
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let index = 0; index < size; index += 1) {
    mark(6, index);
    mark(index, 6);
  }
  for (const row of alignmentPositions(version)) {
    for (const column of alignmentPositions(version)) {
      // 校正图形不与三个探测图形重叠
      const nearFinder = (row <= 8 && column <= 8) || (row <= 8 && column >= size - 9) || (row >= size - 9 && column <= 8);
      if (nearFinder) continue;
      for (let deltaRow = -2; deltaRow <= 2; deltaRow += 1) {
        for (let deltaColumn = -2; deltaColumn <= 2; deltaColumn += 1) mark(row + deltaRow, column + deltaColumn);
      }
    }
  }
  for (let index = 0; index <= 8; index += 1) {
    mark(8, index);
    mark(index, 8);
  }
  for (let index = 0; index < 8; index += 1) {
    mark(8, size - 1 - index);
    mark(size - 1 - index, 8);
  }
  if (version >= 7) {
    for (let index = 0; index < 18; index += 1) {
      mark(size - 11 + (index % 3), Math.floor(index / 3));
      mark(Math.floor(index / 3), size - 11 + (index % 3));
    }
  }
  return reserved;
}

function toBitStream(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let index = length - 1; index >= 0; index -= 1) bits.push((value >> index) & 1);
  };
  push(4, 4); // byte 模式
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const capacity = dataCodewordsFor(version) * 8;
  if (bits.length > capacity) throw new Error(`内容太长：需要 ${bits.length} 位，版本 ${version} 只有 ${capacity} 位`);
  // 结束符：最多 4 个 0，然后补齐到字节边界
  for (let index = 0; index < 4 && bits.length < capacity; index += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  // 交替填充字节 0xEC / 0x11（标准规定）
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (bits.length < capacity) {
    push(padBytes[padIndex % 2] as number, 8);
    padIndex += 1;
  }
  return bits;
}

function toBytes(bits: readonly number[]): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) value = (value << 1) | (bits[index + offset] ?? 0);
    bytes.push(value);
  }
  return bytes;
}

/** 分块 + 纠错 + 交织（数据按块轮流取，纠错码字同理）。 */
function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const entry = L_BLOCKS[version];
  if (entry === undefined) throw new Error(`只支持版本 1..${MAX_VERSION}`);
  const [ecCount, blocks1, data1, blocks2, data2] = entry;
  const data = toBytes(toBitStream(bytes, version));

  const blocks: number[][] = [];
  let cursor = 0;
  for (let index = 0; index < blocks1; index += 1) {
    blocks.push(data.slice(cursor, cursor + data1));
    cursor += data1;
  }
  for (let index = 0; index < blocks2; index += 1) {
    blocks.push(data.slice(cursor, cursor + data2));
    cursor += data2;
  }
  const ecBlocks = blocks.map((block) => reedSolomon(block, ecCount));

  const out: number[] = [];
  const maxData = Math.max(...blocks.map((block) => block.length));
  for (let index = 0; index < maxData; index += 1) {
    for (const block of blocks) if (index < block.length) out.push(block[index] as number);
  }
  for (let index = 0; index < ecCount; index += 1) {
    for (const block of ecBlocks) out.push(block[index] as number);
  }
  return out;
}

function maskApplies(mask: number, row: number, column: number): boolean {
  switch (mask) {
    case 0:
      return (row + column) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return column % 3 === 0;
    case 3:
      return (row + column) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5:
      return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6:
      return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default:
      return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

/** 把码字按标准折线填进矩阵（从右下起，两列一束，跳过第 6 列与功能图形）。 */
function placeData(reserved: boolean[][], modules: boolean[][], codewords: readonly number[]): void {
  const size = modules.length;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 第 6 列是定位图形，整列跳过
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const column of [right, right - 1]) {
        if (reserved[row]?.[column] === true) continue;
        const byte = codewords[Math.floor(bitIndex / 8)];
        const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex % 8))) & 1;
        (modules[row] as boolean[])[column as number] = bit === 1;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

/** 标准里的四条罚分规则（只用于挑选掩码；掩码选错不影响"是合法二维码"，只影响好扫程度）。 */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const columns: boolean[][] = [];
  for (let column = 0; column < size; column += 1) columns.push(modules.map((row) => row[column] as boolean));

  for (const line of [...modules, ...columns]) {
    let run = 1;
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] === line[index - 1]) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = modules[row]?.[column];
      if (value === modules[row]?.[column + 1] && value === modules[row + 1]?.[column] && value === modules[row + 1]?.[column + 1]) {
        score += 3;
      }
    }
  }
  const pattern = [true, false, true, true, true, false, true, false, false, false, false];
  const reversed = [...pattern].reverse();
  const matches = (line: boolean[], at: number, target: boolean[]): boolean =>
    target.every((value, offset) => line[at + offset] === value);
  for (const line of [...modules, ...columns]) {
    for (let index = 0; index + pattern.length <= line.length; index += 1) {
      if (matches(line, index, pattern) || matches(line, index, reversed)) score += 40;
    }
  }
  const dark = modules.flat().filter(Boolean).length;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

function drawFunctionPatterns(modules: boolean[][], reserved: boolean[][], version: number): void {
  const size = modules.length;
  const drawFinder = (top: number, left: number): void => {
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 7; column += 1) {
        const edge = row === 0 || row === 6 || column === 0 || column === 6;
        const core = row >= 2 && row <= 4 && column >= 2 && column <= 4;
        (modules[top + row] as boolean[])[left + column] = edge || core;
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0;
    if (reserved[6]?.[index] === true) (modules[6] as boolean[])[index] = dark;
    if (reserved[index]?.[6] === true) (modules[index] as boolean[])[6] = dark;
  }

  const positions = alignmentPositions(version);
  for (const row of positions) {
    for (const column of positions) {
      const nearFinder = (row <= 8 && column <= 8) || (row <= 8 && column >= size - 9) || (row >= size - 9 && column <= 8);
      if (nearFinder) continue;
      for (let deltaRow = -2; deltaRow <= 2; deltaRow += 1) {
        for (let deltaColumn = -2; deltaColumn <= 2; deltaColumn += 1) {
          const edge = Math.max(Math.abs(deltaRow), Math.abs(deltaColumn));
          (modules[row + deltaRow] as boolean[])[column + deltaColumn] = edge !== 1;
        }
      }
    }
  }
}

function writeFormatAndVersion(modules: boolean[][], version: number, mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);
  for (let index = 0; index < 15; index += 1) {
    const bit = bits[index] === '1';
    // 第一份：左上探测图形周围
    if (index < 6) (modules[8] as boolean[])[index] = bit;
    else if (index === 6) (modules[8] as boolean[])[7] = bit;
    else if (index === 7) (modules[8] as boolean[])[8] = bit;
    else if (index === 8) (modules[7] as boolean[])[8] = bit;
    else (modules[14 - index] as boolean[])[8] = bit;
    // 第二份：右上 / 左下
    if (index < 8) (modules[size - 1 - index] as boolean[])[8] = bit;
    else (modules[8] as boolean[])[size - 15 + index] = bit;
  }
  (modules[size - 8] as boolean[])[8] = true; // 固定的深色模块

  const versionString = versionBits(version);
  if (versionString === undefined) return;
  for (let index = 0; index < 18; index += 1) {
    const bit = versionString[index] === '1';
    const row = size - 11 + (index % 3);
    const column = Math.floor(index / 3);
    (modules[row] as boolean[])[column] = bit;
    (modules[column] as boolean[])[row] = bit;
  }
}

/** 编码成二维码矩阵。内容放不下时自动升版本，超过 20 就明确报错（而不是悄悄出个扫不出来的码）。 */
export function encodeQr(text: string, options: { minVersion?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  const start = Math.max(1, options.minVersion ?? 1);

  let version = start;
  for (; version <= MAX_VERSION; version += 1) {
    const capacityBits = dataCodewordsFor(version) * 8;
    const neededBits = 4 + (version < 10 ? 8 : 16) + bytes.length * 8;
    if (neededBits <= capacityBits) break;
  }
  if (version > MAX_VERSION) {
    throw new Error(`内容太长（${bytes.length} 字节），版本 ${MAX_VERSION} 也放不下；配对链接请用更短的地址或口令`);
  }

  const codewords = buildCodewords(bytes, version);
  const reserved = functionPatternMask(version);
  const size = sizeOf(version);

  let best: { mask: number; modules: boolean[][]; score: number } | undefined;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    drawFunctionPatterns(modules, reserved, version);
    placeData(reserved, modules, codewords);
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        if (reserved[row]?.[column] === true) continue;
        if (maskApplies(mask, row, column)) {
          (modules[row] as boolean[])[column] = !(modules[row]?.[column] as boolean);
        }
      }
    }
    writeFormatAndVersion(modules, version, mask);
    const score = penalty(modules);
    if (best === undefined || score < best.score) best = { mask, modules, score };
  }
  if (best === undefined) throw new Error('掩码选择失败');
  return { version, size, modules: best.modules, mask: best.mask };
}

/** 给界面用：把矩阵变成 SVG path（一个模块一个方格，紧凑且可缩放）。 */
export function qrPathData(code: QrCode, moduleSize = 1): string {
  const parts: string[] = [];
  for (let row = 0; row < code.size; row += 1) {
    for (let column = 0; column < code.size; column += 1) {
      if (code.modules[row]?.[column] === true) {
        parts.push(`M${column * moduleSize} ${row * moduleSize}h${moduleSize}v${moduleSize}h-${moduleSize}z`);
      }
    }
  }
  return parts.join('');
}
