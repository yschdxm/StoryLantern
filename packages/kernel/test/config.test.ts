import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineConfig } from '../../plugin-api/src/index.ts';

const schema = defineConfig({
  provider: { type: 'string', default: 'openai', enum: ['openai', 'anthropic'] },
  retries: { type: 'number', default: 2, min: 0, max: 10, integer: true },
  stream: { type: 'boolean', default: true },
  endpoint: { type: 'string' },
  tags: { type: 'array', items: { type: 'string' }, default: [] },
  limits: {
    type: 'object',
    dict: { context: { type: 'number', default: 8192 }, maxTokens: { type: 'number', default: 2048 } },
    default: {},
  },
});

test('默认值补齐；未声明但可选的字段不出现', () => {
  const result = schema.validate({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    provider: 'openai',
    retries: 2,
    stream: true,
    tags: [],
    limits: { context: 8192, maxTokens: 2048 },
  });
  assert.equal('endpoint' in result.value, false);
});

test('显式值覆盖默认值，嵌套对象按键校验', () => {
  const result = schema.validate({ provider: 'anthropic', limits: { context: 4096 } });
  assert.equal(result.ok, true);
  assert.equal(result.value.provider, 'anthropic');
  assert.deepEqual(result.value.limits, { context: 4096, maxTokens: 2048 });
});

test('类型不符 / 越界 / 枚举外取值都是硬失败', () => {
  const wrongType = schema.validate({ retries: 'many' });
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.errors.join(';'), /retries: 期望 number/);

  const outOfRange = schema.validate({ retries: 99 });
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.errors.join(';'), /retries: 需 ≤ 10/);

  const notInteger = schema.validate({ retries: 1.5 });
  assert.equal(notInteger.ok, false);
  assert.match(notInteger.errors.join(';'), /retries: 需为整数/);

  const badEnum = schema.validate({ provider: 'gemini' });
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.errors.join(';'), /provider: 取值必须是 openai \| anthropic/);
});

test('未声明的键保留原值并记 warning（向前兼容，不丢数据）', () => {
  const result = schema.validate({ provider: 'openai', futureField: { a: 1 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.futureField, { a: 1 });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /futureField: 未声明的配置键/);
});

test('toJsonSchema 反映类型、默认值与必填集合', () => {
  const jsonSchema = schema.toJsonSchema();
  assert.equal(jsonSchema.type, 'object');
  const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.provider?.type, 'string');
  assert.deepEqual(properties.provider?.enum, ['openai', 'anthropic']);
  assert.equal(properties.provider?.default, 'openai');
  assert.equal(properties.limits?.type, 'object');
  assert.deepEqual((jsonSchema.required as string[] | undefined)?.includes('endpoint'), true);
  assert.equal((jsonSchema.required as string[] | undefined)?.includes('provider'), false);
  assert.equal(jsonSchema.additionalProperties, true);
});
