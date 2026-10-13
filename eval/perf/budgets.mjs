/**
 * 性能预算 harness：把 PLAN §11 的预算变成**可运行断言**。
 *
 * 运行：node eval/perf/budgets.mjs
 * 退出码：任何一项 FAIL 即 1（因此可以直接进 CI）。
 *
 * 诚实声明：
 *  - 这里只测**已在 Node 侧实现**的部分；浏览器相关的预算（冷启动、滚动帧率）没有实现，
 *    在表里标 SKIP 而不是假装通过；
 *  - 世界书扫描（M2）与真 tokenizer（M2）尚未实现，用"块图装配"和"显式标注"代替，
 *    绝不用一个更容易的近似去冒充原本的预算；
 *  - 单轮次、单机测量，只看量级与是否越线，不做统计显著性声明。
 */
import { performance } from 'node:perf_hooks';
import { HlcClock } from '../../packages/oplog/src/hlc.ts';
import { Materializer } from '../../packages/oplog/src/materialize.ts';
import { messageAppend, settingSet } from '../../packages/oplog/src/op.ts';
import { packSegment } from '../../packages/oplog/src/segment.ts';
import { createAesGcmCipher, createDeviceSigner, generateDeviceKeyPair, nodeDigest, nodeGzip } from '../../packages/oplog/src/node-adapters.ts';
import { assembleBlocks } from '../../plugins/writing-pipeline/src/index.ts';

const rows = [];

function record(name, measuredMs, budgetMs, note = '') {
  const pass = measuredMs <= budgetMs;
  rows.push({ name, measuredMs, budgetMs, status: pass ? 'PASS' : 'FAIL', note, unit: 'ms' });
}

/** 越大越好的指标（吞吐/压缩比），与 `record` 方向相反。 */
function recordFloor(name, measured, floor, note = '', unit = 'op/s') {
  const pass = measured >= floor;
  rows.push({ name, measuredMs: measured, budgetMs: floor, status: pass ? 'PASS' : 'FAIL', note, unit });
}

function skip(name, budget, note) {
  rows.push({ name, measuredMs: Number.NaN, budgetMs: budget, status: 'SKIP', note, unit: 'ms' });
}

function ms(fn) {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function makeOps(count, deviceId) {
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  const words = ['星野', '岚', '夜巡', '同伴', '低语', '走廊', '风雨', '符文', '法师', '酒馆', '约定', '真相'];
  const ops = [];
  for (let index = 0; index < count; index += 1) {
    let content = '';
    // 刻意加入与下标相关的可变部分：否则语料高度重复会把压缩比虚高，
    // 掩盖真实文本（PLAN §8.3 实测 2.05×–5.61×）的量级。
    for (let word = 0; word < 60; word += 1) content += words[(index * 7 + word * 3) % words.length];
    content += `。${index.toString(36)}${(index * 2654435761) % 997}${index % 13}，第${index + 1}段。`;
    ops.push(
      messageAppend(
        { deviceId, clock },
        { sessionId: '01SESSION', messageId: `01MSG${String(index).padStart(8, '0')}`, author: 'user', content },
      ),
    );
  }
  return ops;
}

// ---------------------------------------------------------------- 1. 块图装配
{
  const blocks = [];
  for (let index = 0; index < 2000; index += 1) {
    const letters = index % 5 === 0 ? 120 : 8; // 总量约 30k token 量级
    blocks.push({
      id: `block-${index}`,
      placement: index % 2 === 0 ? 'system' : 'before-history',
      priority: 1000 - index,
      render: () => '设定：'.repeat(0) + '字'.repeat(letters),
    });
  }
  const context = { sessionTitle: '基准', characterName: '星野', userName: '旅人', transcript: ['一', '二'] };
  const elapsed = ms(() => assembleBlocks(blocks, context, 32_000));
  record('块图装配（2000 块，≈30k token 预算）', elapsed, 50, 'M2 起由真世界书扫描取代');
}

// ---------------------------------------------------------------- 2. op 物化吞吐
{
  const ops = makeOps(5000, 'device-a');
  const materializer = new Materializer();
  const elapsed = ms(() => materializer.applyAll(ops));
  const perSecond = (ops.length / elapsed) * 1000;
  recordFloor('op 追加 + 物化吞吐（5000 op）', Math.round(perSecond), 1000, '预算为下限（≥1000 op/s）');
}

// ---------------------------------------------------------------- 3. 1 万 op 合并
{
  const ops = makeOps(10_000, 'device-b');
  const materializer = new Materializer();
  const elapsed = ms(() => materializer.applyAll(ops));
  record('1 万 op 合并（含排序与索引）', elapsed, 1000);
}

// ---------------------------------------------------------------- 4. 段压缩比（≥3×）
{
  const ops = makeOps(2000, 'device-a');
  const device = generateDeviceKeyPair('device-a');
  const ports = { digest: nodeDigest, compressor: nodeGzip, signer: createDeviceSigner(device) };
  const raw = new TextEncoder().encode(ops.map((op) => JSON.stringify(op)).join('\n')).length;
  const packed = await packSegment({ ops, deviceId: 'device-a', seq: 1, blindSessionId: 'a'.repeat(32), ports });
  const ratio = raw / packed.bytes.length;
  recordFloor('段压缩比（≥3×）', Number.parseFloat(ratio.toFixed(2)), 3, `${raw} B → ${packed.bytes.length} B`, '×');
}

// ---------------------------------------------------------------- 5. 加密吞吐（10MB <200ms）
{
  const cipher = createAesGcmCipher({ key: new Uint8Array(32).fill(9) });
  const plaintext = new Uint8Array(10 * 1024 * 1024).fill(7);
  const aad = new TextEncoder().encode('segment-header');
  const start = performance.now();
  const sealed = await cipher.seal(plaintext, aad);
  const sealMs = performance.now() - start;
  const openStart = performance.now();
  await cipher.open(sealed.nonce, sealed.ciphertext, aad);
  const openMs = performance.now() - openStart;
  record('AES-256-GCM 加密 10MB', sealMs, 200);
  record('AES-256-GCM 解密 10MB', openMs, 200);
}

// ---------------------------------------------------------------- 6. 向量检索（5 万×768 int8 <30ms）
{
  const dimension = 768;
  const count = 50_000;
  const vectors = new Int8Array(count * dimension);
  for (let index = 0; index < vectors.length; index += 1) vectors[index] = ((index * 31) % 255) - 127;
  const query = new Int8Array(dimension);
  for (let index = 0; index < dimension; index += 1) query[index] = ((index * 17) % 255) - 127;

  const elapsed = ms(() => {
    let best = -Infinity;
    let bestIndex = -1;
    for (let vector = 0; vector < count; vector += 1) {
      let dot = 0;
      const offset = vector * dimension;
      for (let index = 0; index < dimension; index += 1) dot += (vectors[offset + index] ?? 0) * (query[index] ?? 0);
      if (dot > best) {
        best = dot;
        bestIndex = vector;
      }
    }
    if (bestIndex < 0) throw new Error('unreachable');
  });
  record('int8 暴力检索（5 万 × 768 维）', elapsed, 30, '决定是否需要 HNSW / native（ADR-0005 迁移规则）');
}

// ---------------------------------------------------------------- 7. 设置类 LWW 写入
{
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  const ops = [];
  for (let index = 0; index < 5000; index += 1) ops.push(settingSet({ deviceId: 'device-c', clock }, { key: `pref.${index % 50}`, value: index }));
  const materializer = new Materializer();
  const elapsed = ms(() => materializer.applyAll(ops));
  record('字段级 LWW 写入（5000 次设置 op）', elapsed, 200);
}

// ---------------------------------------------------------------- 8. 浏览器侧预算（未实现）
skip('冷启动 TTI（中端安卓）', 1500, '需要浏览器/移动壳；M3 实现后测');
skip('1 万消息滚动帧率', 55, '需要浏览器；M3 实现后测');
skip('真 tokenizer 计数（10 万 token）', 300, 'tokenizer 属 M2；当前只有粗估器，不做替代性宣称');

// ---------------------------------------------------------------- 输出
const nameWidth = Math.max(...rows.map((row) => row.name.length)) + 2;
console.log('=== StoryForge 性能预算（PLAN §11）===');
console.log(`环境：Node ${process.version} / ${process.platform} / 单轮次\n`);
console.log('项目'.padEnd(nameWidth) + '实测'.padStart(14) + '预算'.padStart(14) + '结论'.padStart(8));
for (const row of rows) {
  const measured = Number.isNaN(row.measuredMs) ? '—' : `${row.measuredMs.toFixed(2)} ${row.unit}`;
  const budget = `${row.budgetMs} ${row.unit}`;
  console.log(row.name.padEnd(nameWidth) + measured.padStart(14) + budget.padStart(14) + row.status.padStart(8) + (row.note ? `   ${row.note}` : ''));
}

const failed = rows.filter((row) => row.status === 'FAIL');
const skipped = rows.filter((row) => row.status === 'SKIP');
console.log('');
console.log(`通过 ${rows.filter((r) => r.status === 'PASS').length} / 失败 ${failed.length} / 未实现 ${skipped.length}`);
if (failed.length > 0) {
  console.error('✗ 有预算未达标：' + failed.map((row) => row.name).join('、'));
  process.exit(1);
}
