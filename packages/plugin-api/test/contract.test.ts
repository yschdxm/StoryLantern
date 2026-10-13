import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineConfig, Registry, type PluginContext, type PluginLike } from '../src/index.ts';

/**
 * 契约测试：模拟"仓库外作者"。
 *
 * 本文件**只依赖 plugin-api**（外加内核作为宿主来激活它），刻意不 import 任何内部实现——
 * 如果哪天插件作者必须读内核源码才能写插件，这个文件会先失败。
 */

const thirdPartyPlugin: PluginLike = {
  name: 'third-party-example',
  inject: ['example.host'],
  Config: defineConfig({
    greeting: { type: 'string', default: '你好', maxLength: 20 },
    retries: { type: 'number', default: 3, min: 0, max: 9, integer: true },
  }),
  apply(ctx, config) {
    const context = ctx as PluginContext;
    const tags = new Registry<string>();
    context.set('example.greeting', String(config.greeting));
    context.set('example.tags', tags);
    context.effect(() => () => tags.clear());
  },
};

test('第三方插件只靠 plugin-api 就能声明 Config、注册表与生命周期', () => {
  assert.equal(thirdPartyPlugin.inject?.[0], 'example.host');

  const result = thirdPartyPlugin.Config?.validate({ retries: 2 });
  assert.equal(result?.ok, true);
  assert.equal(result?.value.greeting, '你好');
  assert.equal(result?.value.retries, 2);

  const bad = thirdPartyPlugin.Config?.validate({ retries: 99 });
  assert.equal(bad?.ok, false);

  const jsonSchema = thirdPartyPlugin.Config?.toJsonSchema();
  assert.equal(jsonSchema?.type, 'object');
});

test('Config 投影出的 JSON Schema 可以被设置 UI 与 AI 直接消费', () => {
  const schema = thirdPartyPlugin.Config?.toJsonSchema() as {
    properties: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
  assert.equal(schema.properties.greeting?.type, 'string');
  assert.equal(schema.properties.retries?.type, 'integer');
  assert.equal((schema.required ?? []).length, 0, '带默认值的字段不应是必填');
});

test('Registry 的 disposer 语义对第三方插件同样成立', () => {
  const registry = new Registry<{ id: string }>();
  const off = registry.register('a', { id: 'a' });
  assert.equal(registry.has('a'), true);
  off();
  assert.equal(registry.has('a'), false);
  assert.throws(() => {
    registry.register('a', { id: 'a' });
    registry.register('a', { id: 'b' });
  }, /冲突/);
});
