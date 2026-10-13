/**
 * 一次性 spike：cordis（上游 MIT 内核）vs 自研 kernel。
 *
 * 目的不是"谁快 3%"，而是回答三个决策问题：
 *   1. 能力是否对齐（Service / inject / effect / 事件 / Config）；
 *   2. 浏览器/WebView 可行性（是否依赖 Node 内置模块）；
 *   3. 迁移成本（API 形状差异、类型模型差异）。
 *
 * 运行：node bench.mjs
 */
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { createContext } from '../../packages/kernel/src/context.ts';

const PLUGINS = 300;
const EMITS = 20_000;
const LOOKUPS = 200_000;
const EVENT = 'bench/event';
const SERVICE = 'bench.service';

function time(label, fn) {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  return { label, ms, result };
}

async function timeAsync(label, fn) {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { label, ms, result };
}

// ------------------------------------------------------------------ cordis

async function benchCordis() {
  let Context;
  try {
    ({ Context } = await import('cordis'));
  } catch (error) {
    return { ok: false, reason: `无法加载 cordis：${error.message}` };
  }

  const metrics = {};
  const root = new Context();

  const activate = await timeAsync('activation', async () => {
    // 先提供 Service（provider 就是一个普通插件行）
    const provider = root.plugin({
      name: 'bench-provider',
      // cordis 的服务注册是 ctx.provide(name, value)（ctx.set 只能改已 provide 的值）。
      apply(ctx) {
        ctx.provide(SERVICE, { value: 42 });
      },
    });
    await provider;

    const fibers = [];
    for (let index = 0; index < PLUGINS; index += 1) {
      fibers.push(
        root.plugin({
          name: `bench-consumer-${index}`,
          inject: [SERVICE],
          apply(ctx) {
            ctx.on(EVENT, () => index);
          },
        }),
      );
    }
    await Promise.all(fibers);
    metrics.activeConsumers = fibers.length;
    return fibers;
  });
  metrics.activationMs = activate.ms;
  const fibers = activate.result;

  const emit = time('emit', () => {
    for (let index = 0; index < EMITS; index += 1) root.emit(EVENT, index);
  });
  metrics.emitMs = emit.ms;

  const lookup = time('lookup', () => {
    let sink = 0;
    for (let index = 0; index < LOOKUPS; index += 1) sink += root.get(SERVICE)?.value ?? 0;
    return sink;
  });
  metrics.lookupMs = lookup.ms;

  // 对照：cordis 的惯例是"取一次、缓存引用"，用来区分"每次调用开销"与"框架固有成本"。
  const cached = time('lookupCached', () => {
    const service = root.get(SERVICE);
    let sink = 0;
    for (let index = 0; index < LOOKUPS; index += 1) sink += service?.value ?? 0;
    return sink;
  });
  metrics.lookupCachedMs = cached.ms;

  const dispose = await timeAsync('dispose', async () => {
    await Promise.all(fibers.map((fiber) => fiber.dispose()));
  });
  metrics.disposeMs = dispose.ms;

  return { ok: true, metrics };
}

// ------------------------------------------------------------------ 自研 kernel

async function benchInhouse() {
  const metrics = {};
  const ctx = createContext();

  const activate = await timeAsync('activation', async () => {
    ctx.set(SERVICE, { value: 42 });
    for (let index = 0; index < PLUGINS; index += 1) {
      ctx.inject([SERVICE], (target) => {
        target.on(EVENT, (() => index));
      });
    }
    await ctx.settle();
    metrics.activeConsumers = PLUGINS;
  });
  metrics.activationMs = activate.ms;

  const emit = await timeAsync('emit', async () => {
    for (let index = 0; index < EMITS; index += 1) await ctx.emit(EVENT, index);
  });
  metrics.emitMs = emit.ms;

  const lookup = time('lookup', () => {
    let sink = 0;
    for (let index = 0; index < LOOKUPS; index += 1) sink += ctx.get(SERVICE)?.value ?? 0;
    return sink;
  });
  metrics.lookupMs = lookup.ms;

  const cached = time('lookupCached', () => {
    const service = ctx.get(SERVICE);
    let sink = 0;
    for (let index = 0; index < LOOKUPS; index += 1) sink += service?.value ?? 0;
    return sink;
  });
  metrics.lookupCachedMs = cached.ms;

  const dispose = await timeAsync('dispose', async () => {
    await ctx.dispose();
  });
  metrics.disposeMs = dispose.ms;

  return { ok: true, metrics };
}

// ------------------------------------------------------------------ 输出

const cordis = await benchCordis();
const inhouse = await benchInhouse();

const rows = [
  ['依赖注入激活（300 个消费者）', cordis, inhouse, 'activationMs'],
  [`事件广播（${EMITS.toLocaleString()} 次 × 300 监听器）`, cordis, inhouse, 'emitMs'],
  [`Service 查找·每次调用（${LOOKUPS.toLocaleString()} 次）`, cordis, inhouse, 'lookupMs'],
  [`Service 查找·缓存引用（${LOOKUPS.toLocaleString()} 次）`, cordis, inhouse, 'lookupCachedMs'],
  ['整体卸载', cordis, inhouse, 'disposeMs'],
];

console.log('=== cordis vs 自研 kernel（同一台机器、同一轮次）===');
console.log('');
let cordisVersion = '不可用';
try {
  cordisVersion = JSON.parse(readFileSync(new URL('./node_modules/cordis/package.json', import.meta.url), 'utf8')).version;
} catch {
  /* 忽略：只影响版本显示 */
}
console.log('cordis:', cordis.ok ? `v${cordisVersion}` : `不可用（${cordis.reason}）`);
console.log('');
console.log('项目'.padEnd(46) + 'cordis'.padStart(12) + '自研'.padStart(12) + '倍数'.padStart(10));
for (const [label, a, b, key] of rows) {
  const av = a.ok ? a.metrics[key] : Number.NaN;
  const bv = b.ok ? b.metrics[key] : Number.NaN;
  const ratio = Number.isFinite(av) && Number.isFinite(bv) && bv > 0 ? (av / bv).toFixed(2) : 'n/a';
  console.log(
    label.padEnd(46) +
      `${av.toFixed(1)}ms`.padStart(12) +
      `${bv.toFixed(1)}ms`.padStart(12) +
      `${ratio}x`.padStart(10),
  );
}
console.log('');
console.log('说明：cordis 的 emit 是同步的，自研 kernel 的 emit 是 async（聚合错误后抛出），');
console.log('      因此事件一项不是严格同语义对比，仅作量级参考。');
