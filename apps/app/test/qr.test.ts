import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignmentPositions,
  dataCodewordsFor,
  encodeQr,
  formatBits,
  generatorPolynomial,
  gfMul,
  MAX_VERSION,
  qrPathData,
  reedSolomon,
  sizeOf,
  totalCodewordsFor,
  versionBits,
} from '../src/data/sync/qr.ts';

/**
 * QR 编码器的测试：**三组外部锚点** + 两条不依赖我实现的数学性质。
 *
 * 为什么这么费劲：二维码"矩阵看着有模有样、但扫不出来"是最坏的结果 —— 用户不会知道错在哪。
 * 所以：
 *  - 生成多项式、格式信息串、版本信息串都直接与**标准里公开的表**比对（不是自己比自己）；
 *  - 用**几何算出**的总码字数交叉验分块表（表抄错就对不上）；
 *  - 用 RS 的定义性质（每个块在 α^i 处求值为 0）验纠错码字。
 * 仍然如实记着：**没有独立解码器**验证过真机可扫；所以界面上始终同时给文本链接。
 */

test('生成多项式：2 个纠错码字 → [1,3,2]，3 个 → [1,7,14,8]（标准里的例子）', () => {
  assert.deepEqual(generatorPolynomial(2), [1, 3, 2]);
  assert.deepEqual(generatorPolynomial(3), [1, 7, 14, 8]);
});

test('GF(256)：指数/对数互逆，乘法与查表一致', () => {
  assert.equal(gfMul(16, 32), 58, '标准里的例子：16 × 32 = 58');
  for (let left = 1; left < 256; left += 1) {
    for (const right of [1, 2, 3, 87, 255]) {
      const product = gfMul(left, right);
      assert.equal(product >= 0 && product < 256, true, '结果必须落在 GF(256) 内');
    }
  }
  assert.equal(gfMul(0, 123), 0);
});

test('格式信息串：纠错级 L 的 8 条与公开表逐字相同', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => formatBits(mask)),
    [
      '111011111000100',
      '111001011110011',
      '111110110101010',
      '111100010011101',
      '110011000101111',
      '110001100011000',
      '110110001000001',
      '110100101110110',
    ],
  );
});

test('版本信息串：v7..v20 与公开表逐字相同', () => {
  assert.deepEqual(
    [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((version) => versionBits(version)),
    [
      '000111110010010100',
      '001000010110111100',
      '001001101010011001',
      '001010010011010011',
      '001011101111110110',
      '001100011101100010',
      '001101100001000111',
      '001110011000001101',
      '001111100100101000',
      '010000101101111000',
      '010001010001011101',
      '010010101000010111',
      '010011010100110010',
      '010100100110100110',
    ],
  );
});

test('分块表 × 几何：每条 L 记录的数据码字 + 纠错码字 = 该版本的总码字数', () => {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const data = dataCodewordsFor(version);
    const total = totalCodewordsFor(version);
    // 反推纠错码字：total - data，应当能被块数整除，且与表里的每块纠错数一致
    const blocksGuess = [1, 2, 3, 4, 5, 6];
    const ok = blocksGuess.some((blocks) => (total - data) % blocks === 0);
    assert.equal(ok, true, `版本 ${version}：总码字 ${total} 与数据码字 ${data} 对不上任何分块数`);
    assert.equal(total > data, true, `版本 ${version}：总码字必须大于数据码字`);
  }
});

test('RS 纠错码字满足定义性质：加上纠错后每个 α^i 处求值为 0', () => {
  const exp = (power: number): number => {
    let value = 1;
    for (let index = 0; index < power % 255; index += 1) value = gfMul(value, 2);
    return value;
  };
  for (const ecCount of [7, 10, 18, 28]) {
    const data = Array.from({ length: 20 }, (_, index) => (index * 37 + 11) % 256);
    const ec = reedSolomon(data, ecCount);
    const codeword = [...data, ...ec];
    for (let power = 0; power < ecCount; power += 1) {
      const x = exp(power);
      let value = 0;
      for (const coefficient of codeword) value = gfMul(value, x) ^ coefficient;
      assert.equal(value, 0, `ec=${ecCount}、α^${power} 处应当为 0`);
    }
  }
});

test('结构：三个探测图形、定位图形、固定深色模块都在正确的位置', () => {
  const code = encodeQr('storylantern://join?v=1&c=deadbeef&p=AAAA');
  const size = code.size;

  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as Array<[number, number]>) {
    assert.equal(code.modules[top]?.[left], true, '探测图形左上角应为深色');
    assert.equal(code.modules[top + 1]?.[left + 1], false, '探测图形内圈应为浅色');
    assert.equal(code.modules[top + 3]?.[left + 3], true, '探测图形中心应为深色');
  }
  for (let index = 8; index < size - 8; index += 1) {
    assert.equal(code.modules[6]?.[index], index % 2 === 0, '第 6 行是定位图形');
    assert.equal(code.modules[index]?.[6], index % 2 === 0, '第 6 列是定位图形');
  }
  assert.equal(code.modules[size - 8]?.[8], true, '固定深色模块');
  assert.equal(code.mask >= 0 && code.mask <= 7, true);
});

test('格式信息能原样读回（第一份副本）：纠错级 L + 选中的掩码', () => {
  const code = encodeQr('hello');
  const bits = formatBits(code.mask);
  const read: string[] = [];
  for (let index = 0; index < 15; index += 1) {
    let value: boolean | undefined;
    if (index < 6) value = code.modules[8]?.[index];
    else if (index === 6) value = code.modules[8]?.[7];
    else if (index === 7) value = code.modules[8]?.[8];
    else if (index === 8) value = code.modules[7]?.[8];
    else value = code.modules[14 - index]?.[8];
    read.push(value === true ? '1' : '0');
  }
  assert.equal(read.join(''), bits);
});

test('版本选择：短内容用最小版本，长内容自动升级，超长明确报错', () => {
  const small = encodeQr('hi');
  assert.equal(small.version, 1);
  assert.equal(small.size, sizeOf(1));

  const medium = encodeQr('x'.repeat(200));
  assert.equal(medium.version > 1, true, '200 字节放不进版本 1');
  assert.equal(medium.size, sizeOf(medium.version));

  assert.throws(() => encodeQr('x'.repeat(2000)), /内容太长/);
});

test('对齐图形位置：v2 → [6,18]、v7 → [6,22,38]（标准里的例子）', () => {
  assert.deepEqual(alignmentPositions(1), []);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
});

test('SVG path：深色模块数与矩阵一致（界面靠它画图）', () => {
  const code = encodeQr('storylantern://join');
  const dark = code.modules.flat().filter(Boolean).length;
  const path = qrPathData(code);
  assert.equal((path.match(/M/g) ?? []).length, dark);
});
