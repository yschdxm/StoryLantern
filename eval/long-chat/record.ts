#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildChatRequest } from '../../apps/app/src/data/prompt.ts';
import type { ChatCall, ChatClient } from '../../apps/app/src/data/chat-client.ts';
import { buildLongConversation, createRecorder, PROBES, scoreProbes, type Recording } from './harness.ts';

/**
 * 用**真实 provider** 录一份长对话评估集，并当场算出"事实题正确率"。
 *
 * 这是 M4 那条判据（"事实题正确率 ≥90% 且引用正确"）唯一的真实来源：
 * 没有真实模型就没有真实的答对率 —— 用桩或 mock 录出来的数字**不是**那个东西。
 *
 * 用法（离线自检，用仓库里的假模型）：
 *   node scripts/mock-openai.mjs 15198 &
 *   node eval/long-chat/record.ts --base-url http://127.0.0.1:15198/v1 --model mock --out eval/long-chat/recordings/mock.json
 *
 * 用法（真实模型；密钥只从环境变量取，**不进仓库、不进日志**）：
 *   STORYLANTERN_API_KEY=sk-... node eval/long-chat/record.ts \
 *     --base-url https://api.deepseek.com/v1 --model deepseek-chat \
 *     --out eval/long-chat/recordings/deepseek-chat.json
 *
 * 设计上的三条硬规矩：
 *  1. **必须显式给 --base-url**：不给就报错退出，避免"随手跑一下"录出个不知道是谁的东西；
 *  2. **非本机地址没有 key 就拒绝**：真实 provider 需要密钥，缺了就直接说清楚，不去试；
 *  3. **录制里标明来源**（model@host + 时间 + temperature）：mock 录出来的文件一眼能看出是 mock，
 *     不会被误当成真实成绩。
 */

interface Args {
  baseUrl: string;
  model: string;
  out: string;
  keyEnv: string;
  temperature: number;
  timeoutMs: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const baseUrl = get('base-url');
  if (baseUrl === undefined || baseUrl === '') {
    console.error(
      '缺少 --base-url。例：--base-url http://127.0.0.1:15198/v1（假模型）或 --base-url https://api.deepseek.com/v1（真实）',
    );
    process.exit(2);
  }
  const model = get('model') ?? 'mock';
  return {
    baseUrl,
    model,
    out: get('out') ?? path.join('eval', 'long-chat', 'recordings', `${model}.json`),
    keyEnv: get('key-env') ?? 'STORYLANTERN_API_KEY',
    temperature: Number(get('temperature') ?? '0'),
    timeoutMs: Number(get('timeout') ?? '120000'),
  };
}

const isLocal = (url: string): boolean => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);

/** 一次流式调用：把 SSE 的分片拼成完整回复。 */
async function callOnce(args: Args, apiKey: string | undefined, call: ChatCall): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const response = await fetch(`${args.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: args.model,
        temperature: args.temperature,
        stream: true,
        messages: [
          ...(call.systemPrompt === undefined || call.systemPrompt === '' ? [] : [{ role: 'system', content: call.systemPrompt }]),
          ...call.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${response.statusText}${text === '' ? '' : `：${text.slice(0, 200)}`}`);
    }
    if (response.body === null) throw new Error('响应没有 body（无法流式读取）');
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) {
          const payload = line.slice(5).trim();
          if (payload !== '' && payload !== '[DONE]') {
            try {
              const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
              const piece = parsed.choices?.[0]?.delta?.content;
              if (typeof piece === 'string') answer += piece;
            } catch {
              // 假服务/真实服务都可能插入心跳注释：忽略解析不了的片段，而不是整段失败
            }
          }
        }
        newline = buffer.indexOf('\n');
      }
    }
    return answer;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env[args.keyEnv];
  if (!isLocal(args.baseUrl) && (apiKey === undefined || apiKey === '')) {
    console.error(
      `目标不是本机地址（${args.baseUrl}），但没有在环境变量 ${args.keyEnv} 里找到密钥。\n` +
        '真实模型需要密钥；密钥只从环境变量取（不进仓库、不进日志）。要离线自检请指向本机的假模型。',
    );
    process.exit(2);
  }

  // 每条探针都当成一次真实对话请求：探针问题接在 500 条长对话之后，走**真实装配**
  const answers = new Map<string, string>();

  const inner: ChatClient = {
    available: true,
    async reply(call) {
      const text = await callOnce(args, apiKey, call);
      return { text, aborted: false };
    },
    async probe() {
      return { ok: true, message: 'record.ts 不实现 probe' };
    },
  };
  const recorder = createRecorder(inner, args.model + String.fromCharCode(64) + new URL(args.baseUrl).host);

  const history = buildLongConversation();
  for (const probe of PROBES) {
    const request = buildChatRequest({
      settings: {},
      history: [...history, { role: 'user', content: probe.question, status: 'done' }],
    });
    const result = await recorder.client.reply({ messages: request.messages, systemPrompt: request.systemPrompt }, {});
    answers.set(probe.id, result.text);
    console.log(`  ${probe.id} 第 ${probe.at} 条 → ${result.text.slice(0, 40).replace(/\n/g, ' ')}…`);
  }

  const summary = scoreProbes(PROBES, answers);
  const recording: Recording = {
    ...recorder.recording,
    // 来源写清楚：mock 录出来的文件一眼能看出是 mock，不会被误当成真实成绩
    producedBy: `${recorder.recording.producedBy}|temperature=${args.temperature}|${new Date().toISOString()}`,
  };
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');

  console.log('');
  console.log(`  录制：${recording.entries.length} 条 → ${args.out}`);
  console.log(`  来源：${recording.producedBy}`);
  console.log(`  事实题正确率：${summary.correct}/${summary.total} = ${(summary.rate * 100).toFixed(0)}%`);
  for (const outcome of summary.outcomes) {
    if (!outcome.correct) console.log(`    ✗ ${outcome.id}：${outcome.answer.slice(0, 60).replace(/\n/g, ' ')}`);
  }
  if (args.model === 'mock' || isLocal(args.baseUrl)) {
    console.log('  ⚠️ 这是本机假模型录的，**不是**真实模型的答对率；要真实成绩请指向真实 provider。');
  }
}

await main();
