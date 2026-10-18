import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLoreBlock, scanLore, type ScanBook, type ScanEntry, type ScanMessage } from '../src/index.ts';

/**
 * 世界书扫描的规则都得能被断言，否则"智能"就只是一句口号。
 * 这些测试本身就是这份语义的说明书。
 */

const book = (entries: ScanBook['entries'], overrides: Partial<ScanBook> = {}): ScanBook => ({
  id: 'B1',
  name: '星野的世界',
  entries,
  ...overrides,
});

const entry = (id: string, keys: string[], content: string, rest: Partial<ScanBook['entries'][number]> = {}) => ({
  id,
  keys,
  content,
  ...rest,
});

const history = (...contents: string[]): ScanMessage[] => contents.map((content, index) => ({
  role: index % 2 === 0 ? 'user' : 'character',
  content,
}));

test('关键词命中：中文关键词按子串匹配，未命中不注入', () => {
  const books = [book([entry('e1', ['铜铃'], '铜铃是隘口的报信之物。'), entry('e2', ['雪'], '雪线以上没有活物。')])];
  const result = scanLore({ books, messages: history('我在隘口听见了铜铃') });
  assert.deepEqual(result.matched.map((item) => item.entryId), ['e1']);
  assert.deepEqual(result.matched[0]?.matchedKeys, ['铜铃']);
  assert.equal(result.matched[0]?.reason, 'keyword');
});

test('大小写：默认不敏感，打开后按原文比较', () => {
  const insensitive = [book([entry('e1', ['Star'], '星。')])];
  assert.equal(scanLore({ books: insensitive, messages: history('the star shines') }).matched.length, 1);

  const sensitive = [book([entry('e1', ['Star'], '星。', { caseSensitive: true })])];
  assert.equal(scanLore({ books: sensitive, messages: history('the star shines') }).matched.length, 0);
  assert.equal(scanLore({ books: sensitive, messages: history('Star shines') }).matched.length, 1);
});

test('次级关键词：要求也命中，否则不注入（selective 语义）', () => {
  const books = [book([entry('e1', ['铜铃'], '铜铃是隘口的报信之物。', { secondaryKeys: ['隘口'] })])];
  assert.equal(scanLore({ books, messages: history('铜铃响了') }).matched.length, 0);
  assert.equal(scanLore({ books, messages: history('铜铃在隘口响了') }).matched.length, 1);
});

test('常量条目：不看关键词，只要书激活就注入', () => {
  const books = [book([entry('e1', [], '这个世界有两轮月亮。', { constant: true })])];
  const result = scanLore({ books, messages: history('随便说点什么') });
  assert.deepEqual(result.matched.map((item) => item.reason), ['constant']);
  // 整本书被关掉时，常量条目也不出现
  assert.equal(scanLore({ books: [book([entry('e1', [], '内容', { constant: true })], { enabled: false })], messages: [] }).matched.length, 0);
});

test('深度窗口：窗口外的旧消息不触发，默认只看最近 4 条', () => {
  const books = [book([entry('e1', ['铜铃'], '铜铃的设定。')])];
  const long = history('铜铃出现在很早的地方', '第二句', '第三句', '第四句', '第五句', '第六句');
  // 默认深度 4：最后 4 条里没有"铜铃"
  assert.equal(scanLore({ books, messages: long }).matched.length, 0);
  // 放大默认深度就能看到
  assert.equal(scanLore({ books, messages: long, scanDepth: 10 }).matched.length, 1);
  // 条目自己指定深度也生效
  const deep = [book([entry('e1', ['铜铃'], '铜铃的设定。', { depth: 10 })])];
  assert.equal(scanLore({ books: deep, messages: long }).matched.length, 1);
});

test('整词匹配：ASCII 词要词边界（bell 不命中 umbrella），CJK 仍按子串', () => {
  const whole = [book([entry('e1', ['bell'], '铃的设定。', { matchWholeWords: true })])];
  assert.equal(scanLore({ books: whole, messages: history('an umbrella') }).matched.length, 0, 'bell 不能命中 umbrella');
  assert.equal(scanLore({ books: whole, messages: history('the bell rings') }).matched.length, 1);
  assert.equal(scanLore({ books: whole, messages: history('BELL rings') }).matched.length, 1, '大小写默认不敏感仍生效');
  // CJK 不能整词化：铃 必须仍命中 铜铃
  const cjk = [book([entry('e2', ['铃'], '铜铃的设定。', { matchWholeWords: true })])];
  assert.equal(scanLore({ books: cjk, messages: history('铜铃响了') }).matched.length, 1);
  // 次级关键词也走同一套规则
  const secondary = [book([entry('e3', ['bell'], '内容', { matchWholeWords: true, secondaryKeys: ['umbrella'] })])];
  assert.equal(scanLore({ books: secondary, messages: history('the bell under an umbrella') }).matched.length, 1);
});

test('正在输入的那句话也参与匹配（否则打字时提到的设定不会触发）', () => {
  const books = [book([entry('e1', ['铜铃'], '铜铃的设定。')])];
  assert.equal(scanLore({ books, messages: history('无关的一句'), extraText: '我把铜铃摘下来' }).matched.length, 1);
});

test('递归：命中条目的正文可以触发另一条，且 respect recursive=false', () => {
  const books = [
    book([
      entry('e1', ['铜铃'], '铜铃与守夜人有关。'),
      entry('e2', ['守夜人'], '守夜人由隘口的旅人轮值。'),
    ]),
  ];
  const result = scanLore({ books, messages: history('听见铜铃') });
  assert.deepEqual(result.matched.map((item) => item.entryId).sort(), ['e1', 'e2']);
  assert.equal(result.matched.find((item) => item.entryId === 'e2')?.reason, 'recursive');

  // 关掉递归后，第二条不会被第一次命中带出来
  const noRecursion = [book([entry('e1', ['铜铃'], '铜铃与守夜人有关。', { recursive: false }), entry('e2', ['守夜人'], '守夜人由旅人轮值。')])];
  assert.deepEqual(scanLore({ books: noRecursion, messages: history('听见铜铃') }).matched.map((item) => item.entryId), ['e1']);
});

test('递归不会无限循环（A 触发 B、B 又触发 A）', () => {
  const books = [
    book([
      entry('e1', ['甲'], '乙也在场。'),
      entry('e2', ['乙'], '甲也在场。'),
    ]),
  ];
  const result = scanLore({ books, messages: history('甲来了') });
  assert.deepEqual(result.matched.map((item) => item.entryId).sort(), ['e1', 'e2']);
  assert.ok(result.rounds <= 3, `轮数应有上限，实际 ${result.rounds}`);
});

test('预算：按 order 升序优先保留，放不下的进 dropped 而不是静默丢弃', () => {  const big = '字'.repeat(50);
  const books = [
    book([
      entry('e1', ['触发'], `${big}1`, { order: 200 }),
      entry('e2', ['触发'], `${big}2`, { order: 100 }),
      entry('e3', ['触发'], `${big}3`, { order: 50 }),
    ]),
  ];
  const result = scanLore({ books, messages: history('触发'), budgetChars: 120 });
  assert.deepEqual(result.matched.map((item) => item.entryId), ['e3', 'e2']);
  assert.deepEqual(result.dropped.map((item) => item.entryId), ['e1']);
  assert.ok(result.charsUsed <= 120);
});

test('输出与输入顺序无关（两台设备、两次调用都得到同样的注入顺序）', () => {
  const entries = [entry('e1', ['触发'], '一', { order: 10 }), entry('e2', ['触发'], '二', { order: 20 }), entry('e3', ['触发'], '三', { order: 20 })];
  const forward = scanLore({ books: [book(entries)], messages: history('触发') });
  const backward = scanLore({ books: [book([...entries].reverse())], messages: history('触发') });
  assert.deepEqual(
    forward.matched.map((item) => item.entryId),
    backward.matched.map((item) => item.entryId),
  );
  assert.deepEqual(forward.matched.map((item) => item.entryId), ['e1', 'e2', 'e3']);
});

// ---------------------------------------------------------------- ST 高级语义（B3–B6）

test('selectiveLogic 0–3：主键+次键组合按 ST 语义（无次键时都退化为只看主键）', () => {
  const make = (logic: 0 | 1 | 2 | 3) => [
    book([entry('e1', ['alpha'], '内容', { secondaryKeys: ['beta', 'gamma'], selectiveLogic: logic })]),
  ];
  const all = history('alpha beta gamma');
  const some = history('alpha beta');
  const none = history('alpha only');
  assert.equal(scanLore({ books: make(0), messages: some }).matched.length, 1);
  assert.equal(scanLore({ books: make(0), messages: none }).matched.length, 0);
  assert.equal(scanLore({ books: make(1), messages: all }).matched.length, 0, 'NOT ALL：全部次键命中反而不过');
  assert.equal(scanLore({ books: make(1), messages: some }).matched.length, 1);
  assert.equal(scanLore({ books: make(2), messages: some }).matched.length, 0, 'NOT ANY：命中任一次键就不过');
  assert.equal(scanLore({ books: make(2), messages: none }).matched.length, 1);
  assert.equal(scanLore({ books: make(3), messages: all }).matched.length, 1, 'AND ALL：全部次键命中才过');
  assert.equal(scanLore({ books: make(3), messages: some }).matched.length, 0);
  for (const logic of [0, 1, 2, 3] as const) {
    const noSecondary = [book([entry('e1', ['alpha'], '内容', { selectiveLogic: logic })])];
    assert.equal(scanLore({ books: noSecondary, messages: history('alpha') }).matched.length, 1, `logic=${logic}`);
  }
});

test('递归变体：excludeRecursion / preventRecursion / delayUntilRecursion', () => {
  const pair = (extra: Partial<ScanEntry>, secondExtra: Partial<ScanEntry> = {}) => [
    book([entry('a', ['甲'], '乙出现了', extra), entry('b', ['乙'], 'B 设定', secondExtra)]),
  ];
  assert.deepEqual(scanLore({ books: pair({}), messages: history('甲') }).matched.map((item) => item.entryId).sort(), ['a', 'b']);
  assert.deepEqual(scanLore({ books: pair({ excludeRecursion: true }), messages: history('甲') }).matched.map((item) => item.entryId), ['a'], 'exclude：正文不再触发别人');
  const prevent = pair({}, { preventRecursion: true });
  assert.deepEqual(scanLore({ books: prevent, messages: history('甲') }).matched.map((item) => item.entryId), ['a'], 'prevent：不被二次命中');
  assert.deepEqual(scanLore({ books: prevent, messages: history('甲 乙') }).matched.map((item) => item.entryId).sort(), ['a', 'b'], 'prevent 不影响直接命中');
  const delayed = pair({}, { delayUntilRecursion: 2 });
  assert.deepEqual(scanLore({ books: delayed, messages: history('甲') }).matched.map((item) => item.entryId), ['a']);
  assert.deepEqual(scanLore({ books: delayed, messages: history('甲', '闲') }).matched.map((item) => item.entryId), ['a'], '前两轮不参与递归');
  assert.deepEqual(scanLore({ books: delayed, messages: history('甲', '闲', '了') }).matched.map((item) => item.entryId).sort(), ['a', 'b']);
});

test('group：同组只留一条；无权重按优先级，有权重确定性抽取（禁止随机）', () => {
  const grouped = (weights: readonly (number | undefined)[]) => [
    book([
      entry('g1', ['触发'], '一', { group: 'G', order: 100, ...(weights[0] === undefined ? {} : { groupWeight: weights[0] }) }),
      entry('g2', ['触发'], '二', { group: 'G', order: 10, ...(weights[1] === undefined ? {} : { groupWeight: weights[1] }) }),
    ]),
  ];
  const noWeights = scanLore({ books: grouped([undefined, undefined]), messages: history('触发') });
  assert.deepEqual(noWeights.matched.map((item) => item.entryId), ['g2'], '无权重按 order 小者');
  assert.equal(noWeights.suppressed, 1, '被 group 丢掉的数量要计数');
  const weighted = grouped([1, 1]);
  const first = scanLore({ books: weighted, messages: history('触发') });
  const second = scanLore({ books: weighted, messages: history('触发') });
  assert.equal(first.matched.length, 1);
  assert.deepEqual(first.matched.map((item) => item.entryId), second.matched.map((item) => item.entryId), '同输入同结果');
  assert.equal(first.suppressed, 1);
});

test('sticky：命中后 N 轮内继续注入（没有关键词也注入，reason=sticky）', () => {
  const books = [book([entry('e1', ['铜铃'], '铜铃设定', { sticky: 2, depth: 1 })])];
  const sticky = scanLore({ books, messages: history('铜铃', '无关', '无关') });
  assert.deepEqual(sticky.matched.map((item) => item.entryId), ['e1']);
  assert.equal(sticky.matched[0]?.reason, 'sticky');
  assert.equal(scanLore({ books, messages: history('铜铃', '无关', '无关', '无关') }).matched.length, 0);
});

test('cooldown：命中后 N 轮内不再命中（到点恢复）', () => {
  const books = [book([entry('e1', ['铜铃'], '铜铃设定', { cooldown: 2, depth: 1 })])];
  const cooling = scanLore({ books, messages: history('铜铃', '无关', '铜铃') });
  assert.equal(cooling.matched.length, 0);
  assert.equal(cooling.suppressed, 1);
  assert.equal(scanLore({ books, messages: history('铜铃', '无关', '无关', '铜铃') }).matched.length, 1);
});

test('delay：总轮次 < N 时不参与（到点后正常命中）', () => {
  const books = [book([entry('e1', ['铜铃'], '铜铃设定', { delay: 3 })])];
  assert.equal(scanLore({ books, messages: history('铜铃', '铜铃') }).matched.length, 0);
  assert.equal(scanLore({ books, messages: history('铜铃', '铜铃', '铜铃') }).matched.length, 1);
});

test('角色名键（B9）：names 以 \\x01 拼在扫描文本前，历史没提也能触发', () => {
  const books = [book([entry('e1', ['星野'], '主角的设定。')])];
  assert.equal(scanLore({ books, messages: history('随便聊聊') }).matched.length, 0);
  assert.equal(scanLore({ books, messages: history('随便聊聊'), names: ['星野', '林霜'] }).matched.length, 1);
  assert.equal(scanLore({ books, messages: [], extraText: '你好', names: ['星野'] }).matched.length, 1);
});

test('注入文本块：按顺序拼接，空结果返回空串', () => {
  const books = [book([entry('e1', ['触发'], '第一条', { order: 1 }), entry('e2', ['触发'], '第二条', { order: 2 })])];
  assert.equal(formatLoreBlock(scanLore({ books, messages: history('触发') }).matched), '第一条\n第二条');
  assert.equal(formatLoreBlock([]), '');
});
