import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, resolveJsExpressions, YamlError } from '../src/yaml.ts';

test('空 profile 根：字面量 [] 解析为空数组', () => {
  assert.deepEqual(parseYaml('[]\n'), []);
  assert.deepEqual(parseYaml('# 只有注释\n\n'), null);
});

test('解析 DSH 风格的 insert patch（含注释、嵌套序列、标量类型）', () => {
  const text = [
    '# 组合 patch',
    '- insert:',
    "    - id: timer",
    "      name: '@storyforge/plugin-timer'",
    '    - id: llm',
    "      name: '@storyforge/plugin-llm'",
    '      disabled: true',
    '      config:',
    '        retries: 3',
    '        stream: true',
    '        tags: [fast, cheap]',
    "        label: 'a: b'",
  ].join('\n');

  const rows = parseYaml(text) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  const insert = rows[0]?.insert as Array<Record<string, unknown>>;
  assert.equal(insert.length, 2);
  assert.equal(insert[1]?.id, 'llm');
  assert.equal(insert[1]?.disabled, true);
  assert.deepEqual(insert[1]?.config, {
    retries: 3,
    stream: true,
    tags: ['fast', 'cheap'],
    label: 'a: b',
  });
});

test('!!js 表达式被标记而不是当场求值', () => {
  const rows = parseYaml("- id: plugin-manager\n  disabled: !!js \"!ctx.get('profileContext')\"\n") as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(rows[0]?.disabled, { __js: "!ctx.get('profileContext')" });
});

test('!!js 求值：作用域变量可见；失败记入 warnings 而不是抛错', () => {
  const ok = resolveJsExpressions({ disabled: { __js: '!ctx.get("profileContext")' } }, {
    ctx: { get: () => undefined },
  });
  assert.deepEqual(ok.value, { disabled: true });
  assert.deepEqual(ok.warnings, []);

  const failed = resolveJsExpressions({ disabled: { __js: 'this is not js' } }, {});
  assert.deepEqual(failed.value, {});
  assert.equal(failed.warnings.length, 1);
  assert.match(failed.warnings[0] ?? '', /求值失败/);

  const denied = resolveJsExpressions({ disabled: { __js: 'true' } }, {}, { allowJs: false });
  assert.deepEqual(denied.value, {});
  assert.match(denied.warnings[0] ?? '', /已忽略 !!js/);
});

test('不支持或非法的形态必须明确报错，绝不静默猜测', () => {
  assert.throws(() => parseYaml('- id: a\n\tname: b\n'), YamlError);
  assert.throws(() => parseYaml("- id: 'a\n"), YamlError);
  assert.throws(() => parseYaml('- id: a\n   bad: indent\n'), YamlError);
  assert.throws(() => parseYaml('- a: 1\n   b: 2\n- c\n'), YamlError);
  // 顶层 map 可以被解析，但组合层要求的是数组（由 Composition 记 warning）
  assert.deepEqual(parseYaml('id: a\nname: b\n'), { id: 'a', name: 'b' });
});

test('引号与转义', () => {
  const rows = parseYaml("- id: 'it''s'\n  name: \"line\\nbreak\"\n") as Array<Record<string, unknown>>;
  assert.equal(rows[0]?.id, "it's");
  assert.equal(rows[0]?.name, 'line\nbreak');
});
