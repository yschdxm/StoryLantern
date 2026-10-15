import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest } from '../../apps/app/src/data/prompt.ts';
import { SETTING_KEYS } from '../../apps/app/src/data/types.ts';
import { buildLongConversation, DEFAULT_LIMIT, FACTS, TOTAL } from './harness.ts';

/**
 * 长对话「事实是否进得了上下文」的探针评估（M4 地基的第一块）。
 * 数据与探针来自 ./harness.ts（同一条命令永远得到同一份对话）。
 */
/**
 * 这次请求**真正会发出去**的内容（系统提示 + 历史消息 + 实际注入的世界书/记忆）。
 *
 * 注意：**不能**把整个 ChatRequest 序列化去找——`trace` 里带着"被排除消息的预览"，
 * 那会让没进上下文的事实看起来也"在里面"（我第一版就是这么写错的，测试当场把它抓出来了）。
 */
function injectedText(history: ReturnType<typeof buildLongConversation>, limit?: number) {
  const settings: Record<string, string> = limit === undefined ? {} : { [SETTING_KEYS.historyLimit]: String(limit) };
  const request = buildChatRequest({ settings, history });
  const parts = [
    request.systemPrompt,
    ...request.messages.map((message) => message.content),
    JSON.stringify(request.lore ?? []),
    JSON.stringify(request.memory ?? []),
  ];
  const text = parts.join('\n');
  return {
    text,
    hits: FACTS.filter((fact) => text.includes(fact.text)),
    misses: FACTS.filter((fact) => !text.includes(fact.text)),
  };
}

test(`长对话探针：默认上限 ${DEFAULT_LIMIT} 条，只有窗口内的事实进得了上下文（这是 M4 要解决的基线）`, () => {
  const history = buildLongConversation();
  const result = injectedText(history);
  console.log(
    `  [默认历史上限 ${DEFAULT_LIMIT}] 事实命中 ${result.hits.length}/${FACTS.length}：` +
      FACTS.map((fact) => `${fact.at}${result.hits.includes(fact) ? '✓' : '✗'}`).join(' '),
  );
  for (const miss of result.misses) console.log(`    未进上下文：第 ${miss.at} 条（${miss.note}）——「${miss.text}」`);

  // 窗口内的事实**必须**在注入文本里（这条是硬要求）
  const near = FACTS[0];
  assert.ok(near !== undefined && result.text.includes(near.text), '窗口内（倒数第 2 条）的事实必须被注入');
  // 远超窗口的早期事实**必然进不去**——今天的行为就是这样，如实钉住；等 M4 做了摘要/检索，这条会失败并要求更新
  const earliest = FACTS[FACTS.length - 1];
  assert.ok(earliest !== undefined && !result.text.includes(earliest.text), '第 8 条这样早的事实，在默认窗口下不应进上下文');
});

test('长对话探针：把历史上限开到 500，早期事实确实回来了（说明"没进上下文"的原因是窗口，不是别处）', () => {
  const history = buildLongConversation();
  const result = injectedText(history, 500);
  console.log(
    `  [历史上限 500] 事实命中 ${result.hits.length}/${FACTS.length}：` +
      FACTS.map((fact) => `${fact.at}${result.hits.includes(fact) ? '✓' : '✗'}`).join(' '),
  );
  assert.equal(result.hits.length, FACTS.length, '上限开到 500 时，5 条事实都应当进上下文');
});
