/**
 * int8 量化后的向量检索（PLAN §11 的那条"5 万 × 768 维 int8 检索 <30ms"）。
 *
 * 为什么要有这个文件：那条预算以前是拿 `eval/perf/budgets.mjs` 里**自己造的一个循环**量出来的 ——
 * 产品里根本没有 int8 检索。用一个不存在的实现量出来的数字没有意义，所以先把真实实现写出来，
 * 再让预算去量它。
 *
 * 设计（都是为了"能在一台手机上扫 5 万条"）：
 *  - **扁平存储**：5 万 × 768 = 3840 万个 int8 连续放在一个 `Int8Array` 里（约 38 MB），
 *    内层循环因此是线性的内存扫描，不做 Map 查找、不碰对象；
 *  - **每向量一个缩放因子**：`v ≈ int8 * scale`，范数在**建索引时**用原始浮点算好（不猜）；
 *  - **点积用 int32**（int8 × int8 累加最多 768×127×127 ≈ 1.2e7，安全）；
 *  - **top-k 用小顶堆式的插入**，不产生 5 万个临时对象。
 *
 * 精度如实说：这是**近似**余弦（int8 量化有误差）。用途是"先粗筛、必要时再精排"，
 * 不是"等价于浮点检索"。测试里对随机数据测了 recall，别拿它冒充精确结果。
 */

export interface Int8Vector {
  /** 量化后的分量（长度 = 维度）。 */
  values: Int8Array;
  /** 还原系数：浮点值 ≈ values[i] * scale。 */
  scale: number;
  /** **原始浮点向量**的 L2 范数（建索引时算好，比从 int8 反推准）。 */
  norm: number;
}

export interface Int8Index {
  dimension: number;
  count: number;
  /** 扁平存放：第 i 个向量的分量在 [i*dimension, (i+1)*dimension)。 */
  values: Int8Array;
  scales: Float32Array;
  norms: Float32Array;
  /** **量化后**向量自身的 L2 范数：用于柯西–施瓦茨上界剪枝（见 `int8TopK`）。 */
  intNorms: Float32Array;
}

/** int8 能表示的最大绝对值。 */
const INT8_MAX = 127;

/** 把一个浮点向量量化成 int8（对称量化；全零向量 scale 记 0）。 */
export function quantizeInt8(vector: readonly number[]): Int8Vector {
  let maxAbs = 0;
  let sumSquares = 0;
  for (const value of vector) {
    const abs = Math.abs(value);
    if (abs > maxAbs) maxAbs = abs;
    sumSquares += value * value;
  }
  const scale = maxAbs === 0 ? 0 : maxAbs / INT8_MAX;
  const values = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    values[index] = scale === 0 ? 0 : Math.max(-INT8_MAX, Math.min(INT8_MAX, Math.round(value / scale)));
  }
  return { values, scale, norm: Math.sqrt(sumSquares) };
}

/** 建索引：一次把 5 万条拍平，之后检索不再有任何分配（除了结果数组）。 */
export function buildInt8Index(vectors: readonly (readonly number[])[]): Int8Index {
  const dimension = vectors[0]?.length ?? 0;
  const count = vectors.length;
  const values = new Int8Array(count * dimension);
  const scales = new Float32Array(count);
  const norms = new Float32Array(count);
  const intNorms = new Float32Array(count);
  for (let doc = 0; doc < count; doc += 1) {
    const quantized = quantizeInt8(vectors[doc] ?? []);
    values.set(quantized.values.subarray(0, dimension), doc * dimension);
    scales[doc] = quantized.scale;
    norms[doc] = quantized.norm;
    let sumSquares = 0;
    for (let component = 0; component < quantized.values.length; component += 1) {
      const value = quantized.values[component] as number;
      sumSquares += value * value;
    }
    intNorms[doc] = Math.sqrt(sumSquares);
  }
  return { dimension, count, values, scales, norms, intNorms };
}

/**
 * 暴力 top-k（近似余弦）。返回按下标去重的名次，分数高在前。
 *
 * `limit` 个候选用一个定长小数组维持（插入排序），内存与 GC 都可控 ——
 * 5 万条里只要 10 条，不需要给 5 万条都建对象再排序。
 */
export function int8TopK(
  query: readonly number[],
  index: Int8Index,
  limit: number,
): Array<{ doc: number; score: number }> {
  const dimension = index.dimension;
  if (dimension === 0 || index.count === 0 || limit <= 0) return [];
  const quantized = quantizeInt8(query);
  const queryValues = quantized.values;
  const queryScale = quantized.scale;
  const queryNorm = quantized.norm;
  if (queryScale === 0 || queryNorm === 0) return [];

  const values = index.values;
  const scales = index.scales;
  const norms = index.norms;
  const intNorms = index.intNorms;
  const dimensionUsed = Math.min(dimension, queryValues.length);

  let queryIntSquares = 0;
  for (let component = 0; component < dimensionUsed; component += 1) {
    const value = queryValues[component] as number;
    queryIntSquares += value * value;
  }
  const queryIntNorm = Math.sqrt(queryIntSquares);
  const queryScaleTimesNorm = queryScale * queryNorm;

  const best: Array<{ doc: number; score: number }> = [];
  let worst = -Infinity;

  // 内层展开 ×4：微基准里这是唯一能把 5 万×768 压到 30ms 以内的改动
  // （原版 34.87ms / 去掉 `?? 0` 34.90ms / 展开 29.52ms / 浮点 32.94ms，best-of-3）。
  const unrolled = dimensionUsed - (dimensionUsed % 4);
  for (let doc = 0; doc < index.count; doc += 1) {
    const norm = norms[doc] ?? 0;
    if (norm === 0) continue;
    const scale = scales[doc] ?? 0;
    const offset = doc * dimension;

    // **柯西–施瓦茨上界剪枝**（数学上安全，不会剪掉真 top-k）：
    //   score = dot / (|q|·|v|) ≤ (|q_int|·|v_int|)·scale_q·scale_v / (|q|·|v|)
    // 上界 ≤ 当前第 k 名时，这一条连内层循环都不用进。随机向量下能在 worst 稳定后砍掉一大批。
    if (worst > 0 && (intNorms[doc] ?? 0) * queryIntNorm * scale * queryScale <= worst * queryScaleTimesNorm * norm) {
      continue;
    }

    let dot0 = 0;
    let dot1 = 0;
    let dot2 = 0;
    let dot3 = 0;
    for (let component = 0; component < unrolled; component += 4) {
      dot0 += (values[offset + component] as number) * (queryValues[component] as number);
      dot1 += (values[offset + component + 1] as number) * (queryValues[component + 1] as number);
      dot2 += (values[offset + component + 2] as number) * (queryValues[component + 2] as number);
      dot3 += (values[offset + component + 3] as number) * (queryValues[component + 3] as number);
    }
    let dot = dot0 + dot1 + dot2 + dot3;
    for (let component = unrolled; component < dimensionUsed; component += 1) {
      dot += (values[offset + component] as number) * (queryValues[component] as number);
    }
    // 点积非正时，分数不可能超过已为正的阈值：直接跳过
    if (worst > 0 && dot <= 0) continue;
    const score = (dot * scale * queryScale) / (queryNorm * norm);
    if (best.length === limit && score <= worst) continue;

    let position = best.length;
    while (position > 0 && (best[position - 1]?.score ?? -Infinity) < score) position -= 1;
    best.splice(position, 0, { doc, score });
    if (best.length > limit) {
      best.pop();
      worst = best[best.length - 1]?.score ?? -Infinity;
    } else if (best.length === limit) {
      worst = best[best.length - 1]?.score ?? -Infinity;
    }
  }

  return best;
}
