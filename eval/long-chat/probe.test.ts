import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest } from '../../apps/app/src/data/prompt.ts';
import { SETTING_KEYS } from '../../apps/app/src/data/types.ts';

/**
 * 长对话「事实是否进得了上下文」的探针评估（M4 第一步：先做**今天就能测**的那半）。
 *
 * 为什么要它：PLAN 的 M4 判据是"事实题正确率 ≥90% **且引用正确**"，那条要模型、要回放、还要"引用"机制，
 * 今天都还没有（见 docs/M4-STATUS.md 的盘点）。但把问题拆开，有一半**不依赖**摘要/检索/模型：
 * **承载事实的那条消息，究竟有没有被真的注入到这次请求里？** 这一半现在就能确定性地量，而且它能把
 * "模型答不对"与"上下文根本没喂到"两类失败分开——后者是 M4 要解决的问题本体。
 *
 * 数据是**固定 seed** 造出来的（同一条命令任何时候都得到同一份对话），断言是确定性的。
 */

const TOTAL = 500;
/** 历史上限的默认值（apps/app/src/data/prompt.ts 的 DEFAULT_HISTORY_LIMIT）。 */
const DEFAULT_LIMIT = 40;

/** 埋在不同深度的事实：at 是从 1 开始的消息序号。 */
const FACTS = [
  { at: TOTAL - 2, text: '钥匙藏在磨坊西墙第三块砖后面。', note: '很近（窗口内）' },
  { at: TOTAL - 35, text: '铜铃是父亲留下来的遗物。', note: '窗口边缘（第 40 条附近）' },
  { at: 300, text: '她的真名是阿霜，从没跟人说过。', note: '中段' },
  { at: 120, text: '隘口的守夜人叫老周。', note: '很早' },
  { at: 8, text: '出发那天，她穿的是旧靴子。', note: '最开头' },
];

/** 固定 seed 的填充文本：不随运行变化。 */
const words = '风 雪 灯 火 门 影子 铜铃 隘口 星 河 旧地图 守夜人 雪线 茶 靴子 沉默 石头 纸 名字 回声'.split(' ');
let seed = 20261015;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const filler = () =>
  `${Array.from({ length: 8 + Math.floor(rand() * 14) }, () => words[Math.floor(rand() * words.length)]).join('')}。`;

/** 按固定 seed 造 500 条历史，并在指定序号埋入事实。 */
function buildHistory(): Array<{ role: 'user' | 'assistant'; content: string; status: 'done' }> {
  seed = 20261015;
  const byIndex = new Map(FACTS.map((fact) => [fact.at, fact.text]));
  const history: Array<{ role: 'user' | 'assistant'; content: string; status: 'done' }> = [];
  for (let index = 1; index <= TOTAL; index += 1) {
    history.push({
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: byIndex.get(index) ?? (index % 2 === 1 ? `旅人：${filler()}` : `星野：${filler()}`),
      status: 'done',
    });
  }
  return history;
}

/**
 * 这次请求**真正会发出去**的内容（系统提示 + 历史消息 + 实际注入的世界书/记忆）。
 *
 * 注意：**不能**把整个 ChatRequest 序列化去找——`trace` 里带着"被排除消息的预览"，
 * 那会让没进上下文的事实看起来也"在里面"（我第一版就是这么写错的，测试当场把它抓出来了）。
 */
function injectedText(history: Array<{ role: 'user' | 'assistant'; content: string; status: 'done' }>, limit?: number) {
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
  const history = buildHistory();
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
  const history = buildHistory();
  const result = injectedText(history, 500);
  console.log(
    `  [历史上限 500] 事实命中 ${result.hits.length}/${FACTS.length}：` +
      FACTS.map((fact) => `${fact.at}${result.hits.includes(fact) ? '✓' : '✗'}`).join(' '),
  );
  assert.equal(result.hits.length, FACTS.length, '上限开到 500 时，5 条事实都应当进上下文');
});
