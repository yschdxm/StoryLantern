/**
 * QR 编码用到的 GF(256) 算术与 Reed-Solomon。
 *
 * 拆出来的原因：单文件行数门禁；以及这一块是**纯数学**，与"怎么摆进矩阵"是两件事。
 * 测试直接钉住标准里给的生成多项式（2 个纠错码字 → [1,3,2]，3 个 → [1,7,14,8]）。
 */

/** GF(256) 的指数/对数表（本原多项式 0x11d = 285）。 */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value >= 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) EXP[index] = EXP[index - 255] as number;
}

export function gfMul(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return EXP[(LOG[left] as number) + (LOG[right] as number)] as number;
}

/** α^power（power 可大于 255：按模 255 循环）。 */
export function gfExp(power: number): number {
  return EXP[power % 255] as number;
}

/** 生成多项式：`(x - α^0)...(x - α^(degree-1))`，最高次系数恒为 1（不放进数组）。 */
export function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let step = 0; step < degree; step += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let index = 0; index < poly.length; index += 1) {
      next[index] = (next[index] as number) ^ (poly[index] as number);
      next[index + 1] = (next[index + 1] as number) ^ gfMul(poly[index] as number, EXP[step] as number);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon：返回 `ecCount` 个纠错码字。 */
export function reedSolomon(data: readonly number[], ecCount: number): number[] {
  const generator = generatorPolynomial(ecCount);
  const remainder = new Array<number>(ecCount).fill(0);
  for (const byte of data) {
    const factor = (byte ^ (remainder[0] as number)) & 0xff;
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < ecCount; index += 1) {
      remainder[index] = (remainder[index] as number) ^ gfMul(generator[index + 1] as number, factor);
    }
  }
  return remainder;
}
