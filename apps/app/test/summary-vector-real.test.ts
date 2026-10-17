import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WireInvokeRequest, WireManifest, WireTransport } from '../../../packages/wire/src/index.ts';
import { retrieve } from '../../../packages/oplog/src/index.ts';
import { selectSummariesForChat } from '../src/data/summary-vector-select.ts';
import type { PromptSummary } from '../src/data/prompt-blocks-v2.ts';

/**
 * **真实来源**证据：聊天路径“按向量挑摘要”打的是真 moark。
 *
 * 桌面端这一跳本来由宿主的 `chat.embed`（Rust）完成；这里用一个传输替身替它做**同一件事**
 * （POST /embeddings、把原始 {status, body} 交回前端），于是被验证的是**应用自己的代码路径**：
 * selectSummariesForChat → createHostEmbeddingPort → 解析 → 排序 → 记账。
 *
 * 没有 `MOARK_API_KEY` 时明确 skip（不许假跑，也不许悄悄绿着）。
 * 与 `summary-vector-select.test.ts`（确定性假向量源，测排序与截断）分开：那份测逻辑，这份测真实语义。
 */

const API_KEY = process.env.MOARK_API_KEY ?? '';
const BASE_URL = process.env.MOARK_BASE_URL ?? 'https://api.moark.com/v1';
const MODEL = process.env.EMBEDDING_MODEL ?? 'Qwen3-Embedding-8B';
const maybe = API_KEY === '' ? test.skip : test;

function realTransport(): WireTransport {
  return {
    kind: 'test-real-moark',
    async manifest(): Promise<WireManifest> {
      return {
        services: [
          { name: 'chat', description: '', methods: [{ name: 'embed', kind: 'call', description: '' }] },
        ],
      };
    },
    invoke(request: WireInvokeRequest): AsyncIterable<unknown> {
      const payload = (request.args[0] ?? {}) as { model?: string; input?: string[] };
      return (async function* () {
        const response = await fetch(`${BASE_URL.replace(/\/$/, '')}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
          body: JSON.stringify({ model: payload.model ?? MODEL, input: payload.input ?? [] }),
        });
        const body = await response.text();
        yield { status: response.status, body };
      })();
    },
  };
}

const SUMMARY = (id: string, text: string): PromptSummary => ({ id, text, level: 'scene', covers: [] });

/** 目标摘要与查询**没有字面重合**（“旧物/风雪/摇” vs “会响/来头”），专治纯词法检索。 */
const SUMMARIES = [
  SUMMARY('s-target', '父亲留下的那件旧物，摇起来能让风雪停下来。'),
  SUMMARY('s2', '她在雪线以北的营地里清点补给。'),
  SUMMARY('s3', '北境的地图上根本没有这条路。'),
  SUMMARY('s4', '他数到一百，等一个人回来。'),
  SUMMARY('s5', '茶还热着，先喝一口。'),
  SUMMARY('s6', '天亮之前别睡，风会骗人。'),
];
const QUESTION = '她挂在腰间、会响的那个东西，是什么来头？';

maybe('真实向量挑摘要：改写提问能选中真源，且用量按 task=embed 记账（打 moark）', async () => {
  const usage: { modelId: string; promptTokens: number }[] = [];
  const picked = await selectSummariesForChat({
    transport: realTransport(),
    model: MODEL,
    messages: [{ role: 'user', content: QUESTION }],
    summaries: SUMMARIES,
    recordUsage: async (call) => {
      usage.push(call);
    },
  });

  assert.ok(picked !== undefined, '有摘要 + 有通道时不该退回词法');
  const ids = picked.map((item) => item.id);
  // 基线 = **产品自己的**词法路径（零依赖 BM25，见 oplog/retrieval.ts）——不是我自己编的土判据
  const lexical = retrieve(
    QUESTION,
    SUMMARIES.map((summary) => ({ id: summary.id, text: summary.text, kind: 'summary' as const, covers: summary.covers })),
    { limit: 3, kinds: ['summary'] },
  );
  const lexicalRankOfTarget = lexical.findIndex((item) => item.id === 's-target') + 1;
  console.log(`  [真实向量] 查询：${QUESTION}`);
  console.log(`  [真实向量] 向量 top${ids.length}：${ids.join(' > ')}`);
  console.log(`  [真实向量] 产品词法 top${lexical.length}：${lexical.map((item) => item.id).join(' > ')}（真源在第 ${lexicalRankOfTarget === 0 ? '未入选' : lexicalRankOfTarget} 位）`);
  console.log(`  [真实向量] 用量：modelId=${usage[0]?.modelId ?? '(未记账)'} promptTokens=${usage[0]?.promptTokens ?? 0}`);

  assert.equal(ids[0], 's-target', '改写提问下真源必须排第一（这正是纯词法做不到的）');
  assert.equal(usage.length, 1, '每次嵌入请求应记一次账');
  assert.equal(usage[0]?.modelId, MODEL);
  assert.ok((usage[0]?.promptTokens ?? 0) > 0, 'usage 里应带真实 prompt tokens');
});
