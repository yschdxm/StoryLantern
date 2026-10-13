import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/context.ts';
import { Registry } from '../src/registry.ts';

test('Service 注册与撤销：set 返回的 disposer 立即生效', async () => {
  const ctx = createContext();
  const off = ctx.set('llm', { name: 'fake' });
  assert.deepEqual(ctx.get('llm'), { name: 'fake' });
  off();
  assert.equal(ctx.get('llm'), undefined);
});

test('子上下文可见父级 Service，且子上下文销毁不影响父级', async () => {
  const root = createContext();
  root.set('settings', { theme: 'dark' });
  const child = root.extend('session');
  child.set('sessionId', 's1');

  assert.deepEqual(child.get('settings'), { theme: 'dark' });
  assert.equal(root.get('sessionId'), undefined);

  await child.dispose();
  assert.equal(child.get('sessionId'), undefined);
  assert.deepEqual(root.get('settings'), { theme: 'dark' });
});

test('父上下文销毁会级联销毁子上下文', async () => {
  const root = createContext();
  const child = root.extend();
  let disposed = 0;
  child.effect(() => () => {
    disposed += 1;
  });
  await root.dispose();
  assert.equal(disposed, 1);
  assert.equal(child.disposed, true);
});

test('inject：依赖未满足时保持未激活，依赖出现后自动执行', async () => {
  const ctx = createContext();
  let ran = 0;
  ctx.inject(['llm'], () => {
    ran += 1;
    ctx.set('ui.chat', { ready: true });
  });
  await ctx.settle();
  assert.equal(ran, 0);
  assert.equal(ctx.get('ui.chat'), undefined);

  ctx.set('llm', {});
  await ctx.settle();
  assert.equal(ran, 1);
  assert.deepEqual(ctx.get('ui.chat'), { ready: true });
});

test('inject：依赖消失后注册被撤销，再次出现会重新执行', async () => {
  const ctx = createContext();
  let runs = 0;
  ctx.set('llm', {});
  ctx.inject(['llm'], () => {
    runs += 1;
    return () => {
      runs -= 1;
    };
  });
  await ctx.settle();
  assert.equal(runs, 1);

  const offLlm = ctx.set('llm', { v: 2 });
  await ctx.settle();
  assert.equal(runs, 1, '替换 Service 不应重复执行注入');

  ctx.get('llm');
  offLlm();
  await ctx.settle();
  assert.equal(runs, 0, '依赖消失应撤销注入');

  ctx.set('llm', { v: 3 });
  await ctx.settle();
  assert.equal(runs, 1);
});

test('effect 注册与撤销顺序：逆序执行', async () => {
  const ctx = createContext();
  const order: number[] = [];
  ctx.effect(() => () => order.push(1));
  ctx.effect(() => () => order.push(2));
  await ctx.dispose();
  assert.deepEqual(order, [2, 1]);
});

test('waterfall：未调用 next 的监听器接管决策，后续监听器不再执行', async () => {
  const ctx = createContext();
  const seen: string[] = [];
  ctx.on('prompt/assemble', ((value: string, next: (v?: string) => Promise<string>) => {
    seen.push('first');
    return next(`${value}+first`);
  }) as never);
  ctx.on('prompt/assemble', ((value: string, next: (v?: string) => Promise<string>) => {
    seen.push('second');
    return next(`${value}+second`);
  }) as never);
  ctx.on('prompt/assemble', ((value: string) => {
    seen.push('owner');
    return `${value}+owner`;
  }) as never);

  const result = await ctx.waterfall('prompt/assemble', 'base');
  assert.equal(result, 'base+first+second+owner');
  assert.deepEqual(seen, ['first', 'second', 'owner']);
});

test('emit：并行广播，错误聚合后抛出且不影响其它监听器', async () => {
  const ctx = createContext();
  const seen: string[] = [];
  ctx.on('chat/created', (() => {
    seen.push('a');
  }) as never);
  ctx.on('chat/created', (() => {
    seen.push('b');
    throw new Error('boom');
  }) as never);

  await assert.rejects(() => ctx.emit('chat/created'), AggregateError);
  assert.deepEqual(seen, ['a', 'b']);
});

test('Registry：id 冲突即报错，disposer 只移除自己那一条', () => {
  const registry = new Registry<string>();
  const off = registry.register('openai', 'impl-a');
  assert.throws(() => registry.register('openai', 'impl-b'), /冲突/);

  const offB = registry.register('anthropic', 'impl-b');
  off();
  assert.equal(registry.get('openai'), undefined);
  assert.equal(registry.get('anthropic'), 'impl-b');
  offB();
  assert.equal(registry.size, 0);
});

test('captureServices：执行期间注册的 Service 全部随聚合 disposer 撤销', async () => {
  const ctx = createContext();
  const { disposers } = await ctx.captureServices(async () => {
    ctx.set('a', 1);
    ctx.set('b', 2);
    return 'done';
  });
  assert.equal(ctx.get('a'), 1);
  assert.equal(disposers.length, 2);

  for (const disposer of [...disposers].reverse()) await disposer();
  assert.equal(ctx.get('a'), undefined);
  assert.equal(ctx.get('b'), undefined);
});

test('已销毁上下文拒绝新的注册', async () => {
  const ctx = createContext();
  await ctx.dispose();
  assert.throws(() => ctx.set('x', 1), /已销毁/);
  assert.throws(() => ctx.effect(() => () => {}), /已销毁/);
});
