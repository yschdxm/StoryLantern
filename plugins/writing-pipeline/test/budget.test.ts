import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleBlocks,
  estimateTokens,
  truncateToTokenBudget,
  type PromptNode,
} from '../src/index.ts';

/**
 * B20 每块预算/保留策略 + B21 source 的**通用机制**测试（插件层，不依赖应用数据）。
 *
 * 预算顺序（有意为之）：先块内截断，再全局预算丢块；mustKeep 块不参与全局裁剪。
 * 这些测试钉住"为什么"：截断要保住块的开头、必须保留块不能因预算消失。
 */

const nodeOf = (nodes: readonly PromptNode[], id: string): PromptNode | undefined => nodes.find((node) => node.id === id);

test('truncateToTokenBudget：预算内原样返回，不做无意义截断', () => {
  const text = '林霜是北境的剑士。';
  const result = truncateToTokenBudget(text, 800);
  assert.equal(result.text, text);
  assert.equal(result.truncated, false);
  assert.equal(result.droppedChars, 0);
  assert.equal(result.tokens, estimateTokens(text));
});

test('truncateToTokenBudget：超出时按码点截断，末尾加省略号且 token 不超预算', () => {
  const text = '剑'.repeat(2000);
  const result = truncateToTokenBudget(text, 100);
  assert.equal(result.truncated, true);
  assert.ok(result.text.endsWith('…'), '截断要有视觉标记，用户/模型都能看出被截过');
  assert.ok(estimateTokens(result.text) <= 100, `截断后 ${estimateTokens(result.text)} 不应超过 100`);
  assert.ok(result.droppedChars > 0);
  assert.ok(Array.from(result.text).length < Array.from(text).length);
  assert.equal(result.droppedChars, Array.from(text).length - Array.from(result.text).length + 1);
});

test('truncateToTokenBudget：预算缺省 / ≤0 表示不设独立预算（仍受全局预算约束）', () => {
  const text = '长'.repeat(500);
  assert.equal(truncateToTokenBudget(text, undefined).truncated, false);
  assert.equal(truncateToTokenBudget(text, 0).truncated, false);
});

test('每块预算：两块同时超出各自预算时分别截断，而不是整块丢（B20 核心）', () => {
  const graph = assembleBlocks(
    [
      { id: 'character', placement: 'system', priority: 90, tokenBudget: 80, render: () => '角'.repeat(400) },
      { id: 'lore', placement: 'before-history', priority: 50, tokenBudget: 50, render: () => '设'.repeat(300) },
    ],
    { sessionTitle: 'S', transcript: [] },
    10_000,
  );
  const character = nodeOf(graph.nodes, 'character');
  const lore = nodeOf(graph.nodes, 'lore');
  assert.equal(character?.included, true);
  assert.equal(character?.truncated, true);
  assert.ok((character?.tokens ?? 0) <= 80);
  assert.ok((character?.droppedChars ?? 0) > 0);
  assert.equal(character?.tokenBudget, 80);
  assert.equal(lore?.included, true);
  assert.equal(lore?.truncated, true);
  assert.ok((lore?.tokens ?? 0) <= 50);
  assert.match(character?.reason ?? '', /块内截断/);
});

test('保留策略：全局预算不足时 mustKeep 块仍纳入，其余按优先级丢并记录理由', () => {
  const graph = assembleBlocks(
    [
      { id: 'character', placement: 'system', priority: 95, mustKeep: true, render: () => '角'.repeat(120) },
      { id: 'setup', placement: 'system', priority: 99, mustKeep: true, render: () => '处境'.repeat(40) },
      { id: 'lore', placement: 'before-history', priority: 10, render: () => '设定'.repeat(60) },
    ],
    { sessionTitle: 'S', transcript: [] },
    20,
  );
  assert.equal(nodeOf(graph.nodes, 'character')?.included, true, '角色设定没有它这次请求不可用');
  assert.equal(nodeOf(graph.nodes, 'setup')?.included, true, '本局处境同理');
  assert.equal(nodeOf(graph.nodes, 'lore')?.included, false, '非保留块在全局预算不足时被丢');
  assert.match(nodeOf(graph.nodes, 'lore')?.reason ?? '', /预算不足裁掉/);
  assert.match(nodeOf(graph.nodes, 'character')?.reason ?? '', /必须保留/);
  assert.ok(graph.usedTokens > graph.budgetTokens, '必须保留允许超出全局预算，面板会看到理由');
  assert.equal(graph.omitted, 1);
});

test('source：静态对象与按上下文计算的来源都会落到 PromptNode（B21）', () => {
  const graph = assembleBlocks(
    [
      {
        id: 'character',
        placement: 'system',
        priority: 90,
        source: (context) => ({ type: 'character', id: 'c1', label: context.sessionTitle }),
        render: () => '角色',
      },
      { id: 'scene', placement: 'system', priority: 80, source: { type: 'scene', id: 's1', label: '酒馆' }, render: () => '场景' },
      { id: 'plain', placement: 'system', priority: 10, render: () => '无来源' },
    ],
    { sessionTitle: '测试会话', transcript: [] },
    500,
  );
  assert.deepEqual(nodeOf(graph.nodes, 'character')?.source, { type: 'character', id: 'c1', label: '测试会话' });
  assert.deepEqual(nodeOf(graph.nodes, 'scene')?.source, { type: 'scene', id: 's1', label: '酒馆' });
  assert.equal(nodeOf(graph.nodes, 'plain')?.source, undefined, '没填来源就不伪造');
});

test('截断后的 token 计入全局预算；放不下的块整块丢（先截断、后全局裁剪）', () => {
  const graph = assembleBlocks(
    [
      { id: 'a', placement: 'system', priority: 90, tokenBudget: 30, render: () => '甲'.repeat(500) },
      { id: 'b', placement: 'before-history', priority: 10, render: () => '乙'.repeat(200) },
    ],
    { sessionTitle: 'S', transcript: [] },
    30,
  );
  const a = nodeOf(graph.nodes, 'a');
  assert.equal(a?.included, true);
  assert.equal(a?.truncated, true);
  assert.ok((a?.tokens ?? 0) <= 30);
  assert.equal(nodeOf(graph.nodes, 'b')?.included, false);
  assert.equal(graph.usedTokens, a?.tokens);
});
