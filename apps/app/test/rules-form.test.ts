import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateConditions,
  type CardRule,
} from '../../../packages/cards/src/index.ts';
import {
  attachRules,
  checkConditionSyntax,
  draftsToRules,
  emptyActionDraft,
  emptyRuleDraft,
  parseSampleScope,
  rulesToDrafts,
} from '../src/data/rules-form.ts';

/**
 * 规则/行为规则表单：纯逻辑 + 与求值器的联动。
 *
 * 关键性质：
 *  - 往返保留顺序、未知字段与 set_state 的动作字段；
 *  - 空动作 / 没有动作的规则保存前丢弃；
 *  - 条件按行拆分去空；语法检查不因为"变量运行时才有值"误报。
 */

const FIRST: CardRule = {
  id: 'r1',
  enabled: true,
  priority: 100,
  when: { event: 'before_reply', conditions: ['affection >= 70', 'mood == "温柔"'] },
  actions: [
    { type: 'constraint', text: '不替用户行动' },
    { type: 'set_state', state_name: 'affection', state_expr: 'affection + 5' },
  ],
} as CardRule;

const second = {
  id: 'r2',
  enabled: false,
  priority: 20,
  when: { event: 'after_reply' },
  actions: [{ type: 'inject_prompt', text: '补一句环境描写' }],
  'vendor.rule': { keep: true },
} as unknown as CardRule;

test('草稿 ↔ 卡片：顺序、未知字段、set_state 动作字段都保留', () => {
  const originals = [FIRST, second];
  const drafts = rulesToDrafts(originals);
  assert.deepEqual(drafts.map((draft) => draft.id), ['r1', 'r2'], '顺序保持');
  assert.equal(drafts[0]?.enabled, true);
  assert.equal(drafts[1]?.enabled, false);
  assert.equal(drafts[0]?.event, 'before_reply');
  assert.equal(drafts[0]?.conditions, 'affection >= 70\nmood == "温柔"');

  const back = draftsToRules(drafts);
  assert.deepEqual(back.map((rule) => rule.id), ['r1', 'r2']);
  assert.deepEqual(back[0]?.when.conditions, ['affection >= 70', 'mood == "温柔"']);
  assert.deepEqual(back[1]?.when, { event: 'after_reply' });
  assert.equal(back[1]?.enabled, false);
  assert.equal(back[1]?.priority, 20);
  assert.deepEqual((back[1] as unknown as Record<string, unknown>)['vendor.rule'], { keep: true }, '未知字段保留');
  const setState = back[0]?.actions.find((action) => action.type === 'set_state');
  assert.equal(setState?.state_name, 'affection');
  assert.equal(setState?.state_expr, 'affection + 5');
});

test('空动作丢弃；没有任何动作的规则整条丢弃；条件按行拆分去空', () => {
  const rule = emptyRuleDraft();
  rule.conditions = '  affection >= 70  \n\n   \n mood == "温柔" ';
  rule.actions = [emptyActionDraft(), { ...emptyActionDraft('inject_prompt'), text: '  多写环境  ' }];
  const drafts = [rule, { ...emptyRuleDraft(), actions: [] }];

  const built = draftsToRules(drafts);
  assert.equal(built.length, 1, '没有动作的规则被丢弃');
  assert.equal(built[0]?.actions.length, 1, '空动作被丢弃');
  assert.deepEqual(built[0]?.when.conditions, ['affection >= 70', 'mood == "温柔"']);
  assert.equal(built[0]?.actions[0]?.text, '多写环境');
});

test('新建默认值：启用、优先级 100、before_prompt、一个 constraint 动作', () => {
  const rule = emptyRuleDraft();
  assert.ok(rule.id.length > 0);
  assert.equal(rule.enabled, true);
  assert.equal(rule.priority, '100');
  assert.equal(rule.event, 'before_prompt');
  assert.equal(rule.actions.length, 1);
  assert.equal(rule.actions[0]?.type, 'constraint');
  assert.notEqual(emptyRuleDraft().id, rule.id);
});

test('求值联动：条件成立/未知变量报错（不静默当 false）', () => {
  const ok = evaluateConditions(['affection >= 70'], { affection: 80 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.errors, []);

  const missing = evaluateConditions(['missing > 1'], {});
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes('未知变量')), missing.errors.join('；'));

  const falseCondition = evaluateConditions(['affection >= 70'], { affection: 10 });
  assert.equal(falseCondition.ok, false);
  assert.deepEqual(falseCondition.errors, [], '条件为假不是错误');
});

test('语法检查：真实语法错误报错；未知变量不算语法错误（运行时才有值）', () => {
  assert.equal(checkConditionSyntax('affection >= 70').ok, true);
  assert.equal(checkConditionSyntax('affection >=').ok, false);
  assert.equal(checkConditionSyntax('(affection >= 70').ok, false, '括号没闭合是语法错误');

  const unknown = checkConditionSyntax('missing > 1');
  assert.equal(unknown.ok, true, '未知变量在运行时才有值，不应当成语法错误');
  assert.equal(checkConditionSyntax('   ').ok, false);
});

test('parseSampleScope：数字/布尔/字符串/引号自动识别，保序；坏行收集错误', () => {
  const parsed = parseSampleScope('affection = 80\nbrave = true\nmood = "温柔"\nheight = 1.75\nplain = 北境');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.scope, { affection: 80, brave: true, mood: '温柔', height: 1.75, plain: '北境' });

  const bad = parseSampleScope('affection = 80\nno-equals\nempty =\n= 3');
  assert.equal(bad.scope.affection, 80);
  assert.equal(bad.errors.length, 3, bad.errors.join('；'));
});

test('试算联动：parseSampleScope 的值真的能喂给 evaluateConditions', () => {
  const scope = parseSampleScope('affection = 80\nmood = "温柔"').scope;
  const hit = evaluateConditions(['affection >= 70', 'mood == "温柔"'], scope);
  assert.equal(hit.ok, true);

  const low = parseSampleScope('affection = 10').scope;
  const miss = evaluateConditions(['affection >= 70'], low);
  assert.equal(miss.ok, false);
  assert.deepEqual(miss.errors, []);

  const unknown = evaluateConditions(['missing > 1'], parseSampleScope('affection = 80').scope);
  assert.equal(unknown.ok, false);
  assert.ok(unknown.errors.length > 0);
});

test('attachRules：清空规则时移除字段；有规则时挂回', () => {
  const card: { id: string; rules?: readonly CardRule[] } = { id: 'c1', rules: [FIRST] };
  const cleared = attachRules(card, []);
  assert.equal('rules' in cleared, false);
  const attached = attachRules(cleared, [FIRST]);
  assert.equal(attached.rules?.length, 1);
});
