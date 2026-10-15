import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createOpenAiEmbeddingPort } from '../../packages/oplog/src/embedding-openai.ts';
import { PROBES, type Recording } from './harness.ts';
import { answerOf, formatSemanticLine, scoreProbesSemantic } from './semantic-score.ts';

/**
 * **真实答对率**：用真向量做语义判分，把"改了写法但答对了"和"真的没答到"分开。
 *
 * 无 \`MOARK_API_KEY\` 时明确 skip（不许假跑）。用**已有录制**（deepseek-flash 与 mock 各一份），
 * 所以这个测量本身不花钱、可反复跑。
 *
 * 两个断言都是**可证伪**的判别性检查，不是自夸：
 *  1. 语义判分对**真实模型**的命中数应当 ≥ 严格子串（真实模型会改写）；
 *  2. 语义判分对**假模型**（每次回同一句无关文本）应当是 0 —— 否则说明这个判分器根本没有分辨力。
 */

const API_KEY = process.env.MOARK_API_KEY ?? '';
const BASE_URL = process.env.MOARK_BASE_URL ?? 'https://api.moark.com/v1';
const MODEL = process.env.EMBEDDING_MODEL ?? 'Qwen3-Embedding-8B';
const DIR = path.join(import.meta.dirname, 'recordings');

async function loadRecordings(): Promise<Array<{ file: string; recording: Recording }>> {
  let files: string[];
  try {
    files = (await readdir(DIR)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const loaded: Array<{ file: string; recording: Recording }> = [];
  for (const file of files) {
    loaded.push({ file, recording: JSON.parse(await readFile(path.join(DIR, file), 'utf8')) as Recording });
  }
  return loaded;
}

test('真实答对率（语义判分）：区分"改写了但答对"与"没答到"，无密钥则 skip', async (t) => {
  const recordings = await loadRecordings();
  if (API_KEY === '' || recordings.length === 0) {
    console.log('  [语义判分] 缺少 MOARK_API_KEY 或 recordings/ 里没有录制 —— 跳过（不许假跑）');
    t.skip('需要 MOARK_API_KEY 与至少一份录制');
    return;
  }

  const embedder = createOpenAiEmbeddingPort({
    model: MODEL,
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    id: `${MODEL}@real`,
    fetchImpl: async (url, init) =>
      fetch(url, { method: init.method, headers: init.headers, body: init.body, ...(init.signal === undefined ? {} : { signal: init.signal }) }),
  });

  const summaries = new Map<string, { strict: number; semantic: number; total: number }>();
  for (const { file, recording } of recordings) {
    const answers = new Map<string, string>();
    for (const probe of PROBES) {
      const answer = answerOf(recording.entries, probe);
      if (answer !== undefined) answers.set(probe.id, answer);
    }
    const summary = await scoreProbesSemantic(PROBES, answers, embedder);
    summaries.set(file, { strict: summary.strictCorrect, semantic: summary.correct, total: summary.total });
    console.log(formatSemanticLine(`${file}（${recording.producedBy}）`, summary));
  }

  const mock = summaries.get('mock.json');
  const real = summaries.get('deepseek-flash.json');
  if (mock !== undefined) {
    assert.equal(mock.semantic, 0, '假模型每次回同一句无关文本，语义判分必须是 0 —— 否则判分器没有分辨力');
  }
  if (real !== undefined) {
    assert.ok(
      real.semantic >= real.strict,
      `真实模型的语义命中（${real.semantic}）不应低于严格子串（${real.strict}）：严格判分把改写判成错`,
    );
  }
});
