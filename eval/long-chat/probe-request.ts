import { HlcClock, nodeDigest, runSummaries, toHex, utf8, type SummarizeRequest } from '../../packages/oplog/src/index.ts';
import { buildChatRequest } from './legacy-prompt.ts';
import type { PromptSummary } from './legacy-prompt-blocks.ts';
import { FACTS, type Probe } from './harness.ts';

/**
 * 「探针 → 真实请求」的**唯一**构造处：录制与回放都必须走这里。
 *
 * 为什么单独一个文件：录制的键是**请求内容的哈希**，回放请求必须逐字相同 —— 两处各写一遍
 * 就会漂移（上一次给历史消息加编号时，回放就当场缺席了，那是设计使然，但代价是必须重录）。
 *
 * 请求里**带上摘要注入**（\`summaries\`）：不然量到的是"管线里没有记忆"的答对率，
 * 而不是 M4 这条判据（"有了长期记忆之后，事实题答对率如何"）。
 */

const SCENE_SIZE = 20;
const ARC_SIZE = 5;
const SESSION = '会话甲';

const HASH = async (parts: readonly string[]): Promise<string> => toHex(await nodeDigest.sha256(utf8(parts.join('\n'))));

/** 完美摘要器（评估用桩）：覆盖的材料里出现哪条事实，就把那条事实原文当摘要交出去。 */
const perfectSummarize = async (request: SummarizeRequest): Promise<string> => {
  const hit = FACTS.find((fact) => request.inputs.some((line) => line.includes(fact.text)));
  return hit?.text ?? '（这一段没有需要长期记住的事实）';
};

/** 用"完美摘要器"给整段语料算出分层摘要（真实产品里这一步是模型做的）。 */
export async function buildPerfectSummaries(messages: readonly { id: string; role: 'user' | 'assistant' | 'system'; content: string }[]): Promise<PromptSummary[]> {
  const { ops } = await runSummaries({
    sessionId: SESSION,
    messages,
    existing: [],
    options: {
      deviceId: 'device-a',
      clock: new HlcClock(),
      hash: HASH,
      summarize: perfectSummarize,
      modelId: 'perfect-summarizer',
      sceneSize: SCENE_SIZE,
      arcSize: ARC_SIZE,
      limit: 10_000, // 这是评估：要全部单元，不受真机那 24 个上限影响
    },
  });
  return ops.map((op) => {
    const payload = op.payload as { summaryId: string; text: string; level: string; covers: string[] };
    return { id: payload.summaryId, text: payload.text, level: payload.level, covers: [...payload.covers] };
  });
}

export interface ProbeRequestInput {
  probe: Probe;
  history: readonly { id: string; role: 'user' | 'assistant' | 'system'; content: string }[];
  summaries?: readonly PromptSummary[];
  /** 是否给历史消息加引用编号（真实聊天打开）。 */
  cite?: boolean;
}

export function buildProbeRequest(input: ProbeRequestInput): ReturnType<typeof buildChatRequest> {
  return buildChatRequest({
    cite: input.cite ?? true,
    settings: {},
    history: [...input.history, { role: 'user', content: input.probe.question, status: 'done' }],
    ...(input.summaries === undefined ? {} : { summaries: [...input.summaries] }),
  });
}
