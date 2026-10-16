import { writeFileSync } from 'node:fs';

/**
 * 测"直连 provider 的首字延迟"——用来和应用里的「首字 N ms」对比，得到**应用自身的开销**。
 *
 * 为什么要有这个对照：PLAN §11 的预算是"流式首字延迟相对直连 API 开销 <100ms"。
 * 少了"直连"这一半，就没法把网络/mock 的固定延迟（比如 MOCK_TTFT_MS=300）从应用开销里扣掉。
 *
 * 用法：
 *   MOCK_TTFT_MS=300 node scripts/mock-openai.mjs 15198     # 另开一个终端/后台跑
 *   node scripts/measure-ttft.mjs http://127.0.0.1:15198/v1 5
 *
 * 输出每次的首片毫秒数与中位数；数字直接抄进 DEVELOPMENT.md。
 */

const base = process.argv[2] ?? 'http://127.0.0.1:15198/v1';
const runs = Number.parseInt(process.argv[3] ?? '5', 10);
const out = process.argv[4];

const text = async (response) => {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.indexOf('\n\n');
      if (boundary < 0) continue;
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (chunk.includes('"content"')) return 'first-token';
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return 'eof';
};

const body = JSON.stringify({
  model: 'mock',
  stream: true,
  messages: [
    { role: 'system', content: '你叫星野。' },
    { role: 'user', content: '说一句话。' },
  ],
});

const samples = [];
for (let index = 0; index < runs; index += 1) {
  const started = performance.now();
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const status = await text(response);
  const ttft = performance.now() - started;
  samples.push(ttft);
  console.log(`  第 ${index + 1} 次：首片 ${ttft.toFixed(1)} ms（${status}，HTTP ${response.status}）`);
}

const sorted = [...samples].sort((left, right) => left - right);
const median = sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
const summary = `直连 ${base} 共 ${runs} 次：中位数 ${median.toFixed(1)} ms，最小 ${Math.min(...samples).toFixed(1)} ms，最大 ${Math.max(...samples).toFixed(1)} ms`;
console.log(`  ${summary}`);
if (out !== undefined) {
  writeFileSync(out, `${new Date().toISOString()}\n${summary}\n${samples.map((value) => value.toFixed(1)).join(', ')}\n`, 'utf8');
  console.log(`  已写入 ${out}`);
}
