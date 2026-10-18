import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REGEX_SCRIPTS,
  MAX_REGEX_TEXT_LENGTH,
  applyRegexScripts,
  formatRegexLiteral,
  parseRegexLiteral,
  regexScriptsFromSt,
  regexScriptsOfExtensions,
  regexScriptsToSt,
  type RegexScript,
} from '../src/data/regex-scripts.ts';

/** B13：正则脚本执行引擎（纯函数、不 throw、超限计数）。 */

const script = (patch: Partial<RegexScript> = {}): RegexScript => ({
  id: 'r1', name: '测试', find: 'a', replace: 'b', placement: 'user_input', ...patch,
});

test('placement 过滤：只执行匹配的 placement；禁用不执行', () => {
  const scripts = [
    script({ id: 'u', placement: 'user_input', find: 'a', replace: 'U' }),
    script({ id: 'a', placement: 'ai_output', find: 'a', replace: 'A' }),
    script({ id: 'off', placement: 'user_input', find: 'a', replace: 'X', enabled: false }),
  ];
  const result = applyRegexScripts('a', 'user_input', scripts);
  assert.equal(result.text, 'U');
  assert.equal(result.applied, 1);
  assert.deepEqual(result.skipped, []);
  assert.equal(applyRegexScripts('a', 'reasoning', scripts).text, 'a');
});

test('顺序执行：后一条脚本看到前一条的结果', () => {
  const result = applyRegexScripts('a', 'user_input', [
    script({ id: '1', find: 'a', replace: 'b' }),
    script({ id: '2', find: 'b', replace: 'c' }),
  ]);
  assert.equal(result.text, 'c');
  assert.equal(result.applied, 2);
});

test('非法/空正则跳过并计数，不 throw', () => {
  const result = applyRegexScripts('a', 'user_input', [
    script({ id: 'bad', find: '(' }),
    script({ id: 'empty', find: '' }),
    script({ id: 'ok', find: 'a', replace: 'b' }),
  ]);
  assert.equal(result.text, 'b');
  assert.equal(result.applied, 1);
  assert.deepEqual(result.skipped.map((item) => item.id), ['bad', 'empty']);
  assert.equal(result.skipped[0]?.reason, 'invalid_pattern');
  assert.equal(result.skipped[1]?.reason, 'empty_pattern');
});

test('flags：global / caseInsensitive / multiline / dotAll 都生效', () => {
  const global = applyRegexScripts('aaa', 'user_input', [script({ flags: { global: true } })]);
  assert.equal(global.text, 'bbb');
  const single = applyRegexScripts('aaa', 'user_input', [script()]);
  assert.equal(single.text, 'baa');
  const ci = applyRegexScripts('A', 'user_input', [script({ find: 'a', flags: { caseInsensitive: true } })]);
  assert.equal(ci.text, 'b');
  assert.equal(applyRegexScripts('A', 'user_input', [script({ find: 'a' })]).text, 'A');
  const multiline = applyRegexScripts('x\nab', 'user_input', [script({ find: '^ab', replace: 'Z', flags: { multiline: true } })]);
  assert.equal(multiline.text, 'x\nZ');
  const dotAll = applyRegexScripts('a\nb', 'user_input', [script({ find: 'a.*b', replace: 'X', flags: { dotAll: true } })]);
  assert.equal(dotAll.text, 'X');
});

test('上限：脚本数 >50 与文本 >256KiB 都跳过并计数（不是沙箱）', () => {
  const many = Array.from({ length: MAX_REGEX_SCRIPTS + 2 }, (_, index) =>
    script({ id: `r${index}`, find: 'a', replace: 'b' }));
  const result = applyRegexScripts('a', 'user_input', many);
  assert.equal(result.applied, MAX_REGEX_SCRIPTS);
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(result.skipped.map((item) => item.reason), ['too_many_scripts', 'too_many_scripts']);

  const big = 'x'.repeat(MAX_REGEX_TEXT_LENGTH + 1);
  const tooBig = applyRegexScripts(big, 'user_input', [script()]);
  assert.equal(tooBig.text, big);
  assert.equal(tooBig.applied, 0);
  assert.deepEqual(tooBig.skipped, [{ id: '*', reason: 'text_too_large' }]);
});

test('酒馆格式：parse/format 保留 flags，placement 数字映射，非法 placement 跳过', () => {
  const parsed = parseRegexLiteral('/\\(OOC:.*?\\)/gs');
  assert.equal(parsed.find, '\\(OOC:.*?\\)');
  assert.deepEqual(parsed.flags, { global: true, dotAll: true });
  assert.equal(formatRegexLiteral(parsed.find, parsed.flags), '/\\(OOC:.*?\\)/gs');
  assert.deepEqual(parseRegexLiteral('plain(text)'), { find: 'plain(text)', flags: {} });

  const scripts = regexScriptsFromSt([
    { id: 'r1', scriptName: '去 OOC', findRegex: '/\\(OOC:.*?\\)/gs', replaceString: '', placement: [2] },
    { id: 'r2', findRegex: '/^/', replaceString: '[lore] ', placement: [5], disabled: true },
    { id: 'r3', findRegex: '/x/', replaceString: 'y', placement: [9] },
    { id: 'r4', findRegex: '/z/', replaceString: 'w', placement: [9, 6] },
  ]);
  assert.deepEqual(scripts.map((item) => item.placement), ['ai_output', 'world_info', 'reasoning']);
  assert.equal(scripts[0]?.flags?.dotAll, true);
  assert.equal(scripts[1]?.enabled, false);
  assert.equal(scripts[2]?.id, 'r4', '不支持的 placement 跳过，但可回退到下一个支持的');
  assert.deepEqual(regexScriptsToSt(scripts)[0]?.placement, [2]);
  assert.equal(regexScriptsToSt(scripts)[0]?.findRegex, '/\\(OOC:.*?\\)/gs');
});

test('卡片扩展读取：只认 extensions.storylantern.regex_scripts，未知形状按空处理', () => {
  assert.equal(regexScriptsOfExtensions(undefined).length, 0);
  assert.equal(regexScriptsOfExtensions({ foo: 1 }).length, 0);
  const scripts = regexScriptsOfExtensions({ storylantern: { regex_scripts: [script()] } });
  assert.deepEqual(scripts.map((item) => item.id), ['r1']);
});
