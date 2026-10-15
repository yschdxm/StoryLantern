import { createHash } from 'node:crypto';
import { checkCitations, type CitationVerdict } from '../../apps/app/src/data/citations.ts';
import type { ChatCall, ChatClient } from '../../apps/app/src/data/chat-client.ts';

/**
 * M4 评估地基：**录制 / 回放 / 判分**，全部离线、确定性、不需要网络与密钥。
 *
 * 为什么需要它：PLAN 的 M4 判据之一是"事实题正确率 ≥90% 且引用正确"。要量这个，就得先能
 * **把一次模型调用完整录下来、离线重放、并按答案键判分**；否则每次测量都依赖"当时那个模型"，
 * 数字不可比、也不可复现（见 docs/M4-STATUS.md 第六节）。
 *
 * 三条不越界的设计：
 * 1. **回放缺席即报错**（`createReplayClient` 默认 `onMiss: 'throw'`）——绝不在没有录制的情况下
 *    凭空生成一个"答案"，那是假数据。
 * 2. **完美读者模型桩**（`createPerfectReaderModel`）只是把"事实在这条请求里可见吗"照实翻译成一句回答，
 *    它的规则是透明的、写在代码里的。于是它给出的正确率是一个**上界**：假设模型是完美读者，
 *    光靠管线能拿到多少。真实模型只会更低——这条在文档里写清楚。
 * 3. **判分器是字符串答案键**（`scoreProbes`），不是"另一个模型来打分"。它严苛、可能与措辞冲突，
 *    但它是确定性的、可审计的；真要更聪明，那是以后的事，今天不假装。
 */

// ---------------------------------------------------------------- 长对话数据

export const TOTAL = 500;
/** 历史上限的默认值（apps/app/src/data/prompt.ts 的 DEFAULT_HISTORY_LIMIT）。 */
export const DEFAULT_LIMIT = 40;

/** 埋在不同深度的事实：at 是从 1 开始的消息序号。 */
export const FACTS = [
  { at: TOTAL - 2, text: '钥匙藏在磨坊西墙第三块砖后面。', note: '很近（窗口内）' },
  { at: TOTAL - 35, text: '铜铃是父亲留下来的遗物。', note: '窗口边缘（第 40 条附近）' },
  { at: 300, text: '她的真名是阿霜，从没跟人说过。', note: '中段' },
  { at: 120, text: '隘口的守夜人叫老周。', note: '很早' },
  { at: 8, text: '出发那天，她穿的是旧靴子。', note: '最开头' },
];

const words = '风 雪 灯 火 门 影子 铜铃 隘口 星 河 旧地图 守夜人 雪线 茶 靴子 沉默 石头 纸 名字 回声'.split(' ');
let seed = 20261015;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const filler = () =>
  `${Array.from({ length: 8 + Math.floor(rand() * 14) }, () => words[Math.floor(rand() * words.length)]).join('')}。`;

export interface HistoryItem {
  role: 'user' | 'assistant';
  content: string;
  status: 'done';
}

/** 按固定 seed 造 500 条历史，并在指定序号埋入事实。同一条命令永远得到同一份对话。 */
export function buildLongConversation(): HistoryItem[] {
  seed = 20261015;
  const byIndex = new Map(FACTS.map((fact) => [fact.at, fact.text]));
  const history: HistoryItem[] = [];
  for (let index = 1; index <= TOTAL; index += 1) {
    history.push({
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: byIndex.get(index) ?? (index % 2 === 1 ? `旅人：${filler()}` : `星野：${filler()}`),
      status: 'done',
    });
  }
  return history;
}

export interface Probe {
  id: string;
  /** 探针问题（会作为最后一条 user 消息发出去）。 */
  question: string;
  /** 埋点事实原文；答对这些才算对。 */
  fact: string;
  /** 事实所在的消息序号（1 起）。 */
  at: number;
}

export const PROBES: Probe[] = FACTS.map((fact, index) => ({
  id: `P${index + 1}`,
  question: `请回忆：${fact.text.replace(/[。，]/g, '')}——这句话说的是什么？`,
  fact: fact.text,
  at: fact.at,
}));

// ---------------------------------------------------------------- 录制 / 回放

export interface RecordingEntry {
  /** 由请求内容决定的稳定键，便于人肉核对"同一问是不是同一答"。 */
  key: string;
  /** 录制时的最后一问（审计用）。 */
  question: string;
  /** 分片照原样存：回放时同样走流式回调。 */
  chunks: string[];
}

export interface Recording {
  v: 1;
  /** 这份录制是谁产生的（例如 'perfect-reader' 或某个真实模型名）。 */
  producedBy: string;
  entries: RecordingEntry[];
}

/** 请求 → 稳定键：内容变了就是另一个键（避免"改了口径却复用了旧答案"）。 */
export function recordingKey(call: ChatCall): string {
  const payload = JSON.stringify({ system: call.systemPrompt ?? '', messages: call.messages, profile: call.profileId ?? '' });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function lastUserText(call: ChatCall): string {
  for (let index = call.messages.length - 1; index >= 0; index -= 1) {
    const message = call.messages[index];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

export interface Recorder {
  client: ChatClient;
  recording: Recording;
  /** 回放用的客户端（同一份录制）。 */
  replay(): ChatClient;
}

/** 包住一个真实的 ChatClient，把每次回答录下来。 */
export function createRecorder(inner: ChatClient, producedBy: string): Recorder {
  const recording: Recording = { v: 1, producedBy, entries: [] };
  const client: ChatClient = {
    available: true,
    async reply(request, handlers) {
      const chunks: string[] = [];
      const result = await inner.reply(request, {
        ...handlers,
        onDelta: (delta) => {
          chunks.push(delta.delta);
          handlers.onDelta?.(delta);
        },
      });
      // 没走流式（或流式被取消）时，至少把整段答案记下来，回放才有东西
      if (chunks.length === 0 && result.text !== '') chunks.push(result.text);
      recording.entries.push({ key: recordingKey(request), question: lastUserText(request), chunks });
      return result;
    },
    async probe(profileId) {
      return inner.probe(profileId);
    },
  };
  return {
    client,
    recording,
    replay: () => createReplayClient(recording),
  };
}

export interface ReplayOptions {
  /** 录不到时的行为：默认**抛错**（绝不凭空造答案）。 */
  onMiss?: 'throw' | 'empty';
}

export function createReplayClient(recording: Recording, options: ReplayOptions = {}): ChatClient {
  const onMiss = options.onMiss ?? 'throw';
  const byKey = new Map(recording.entries.map((entry) => [entry.key, entry]));
  return {
    available: true,
    async reply(request, handlers) {
      const entry = byKey.get(recordingKey(request));
      if (entry === undefined) {
        if (onMiss === 'throw') {
          throw new Error(
            `回放缺席：这次请求在这份录制里没有对应条目（producedBy=${recording.producedBy}）。` +
              '要么重新录制，要么显式传 onMiss: "empty" —— 不允许凭空生成答案。',
          );
        }
        return { text: '', aborted: false };
      }
      let text = '';
      for (const chunk of entry.chunks) {
        text += chunk;
        handlers.onDelta?.({ delta: chunk });
      }
      return { text, aborted: false };
    },
    async probe() {
      return { ok: true, message: `回放模式（录制来自 ${recording.producedBy}，共 ${recording.entries.length} 条）` };
    },
  };
}

// ---------------------------------------------------------------- 引用判分

/**
 * 「引用正确」的判分（第二半）：把答案里的编号换算回消息，再看那条消息是不是**真的支持**这个答案。
 *
 * 与 `scoreProbes` **刻意分开**：答对与引用对是两个比率。合并成一个数字，
 * 就看不出「答对了但引用错」这种最需要修的情况。
 *
 * `window` 必须与装配时的编号窗口一致（都是交给模型的那批消息），否则编号会指错人。
 * 「支持」的判据由调用方写死在这里：这条消息的正文包含答案键 —— 确定性、可审计。
 */
export interface CitationOutcome {
  id: string;
  verdict: CitationVerdict;
  reason: string;
  /** 答案本身对不对，便于一眼看出「答对但引用错」。 */
  answerCorrect: boolean;
}

export interface CitationSummary {
  total: number;
  /** 至少一条引用的消息支持答案。 */
  correct: number;
  noCitation: number;
  wrongCitation: number;
  unresolvable: number;
  rate: number;
  outcomes: CitationOutcome[];
}

export function scoreCitations(
  probes: readonly Probe[],
  answers: ReadonlyMap<string, string>,
  window: readonly { id: string; content: string }[],
): CitationSummary {
  const outcomes: CitationOutcome[] = probes.map((probe) => {
    const answer = answers.get(probe.id) ?? '';
    const check = checkCitations(answer, window, (messageId) => {
      const message = window.find((item) => item.id === messageId);
      return message !== undefined && message.content.includes(probe.fact);
    });
    return { id: probe.id, verdict: check.verdict, reason: check.reason, answerCorrect: answer.includes(probe.fact) };
  });
  const count = (verdict: CitationVerdict): number => outcomes.filter((outcome) => outcome.verdict === verdict).length;
  const correct = count('correct');
  return {
    total: outcomes.length,
    correct,
    noCitation: count('no-citation'),
    wrongCitation: count('wrong-citation'),
    unresolvable: count('unresolvable'),
    rate: outcomes.length === 0 ? 0 : correct / outcomes.length,
    outcomes,
  };
}

// ---------------------------------------------------------------- 模型桩与判分

/**
 * "完美读者"模型桩：**当且仅当**答案键里的事实出现在这次请求的可见内容里，就照抄那一条事实；否则说不知道。
 *
 * 规则是透明的、写死在这里，所以它给出的正确率是**上界**（假设模型是完美读者）；
 * 它在测的是**管线有没有把事实喂到**，不是模型好不好。别把它当"模型质量"的证据。
 */
export function createPerfectReaderModel(probes: readonly Probe[]): ChatClient {
  return {
    available: true,
    async reply(request, handlers) {
      const visible = [request.systemPrompt ?? '', ...request.messages.map((message) => message.content)].join('\n');
      const question = lastUserText(request);
      const probe = probes.find((item) => item.question === question);
      const answer = probe !== undefined && visible.includes(probe.fact) ? probe.fact : '我不知道。';
      // 分两片发，顺便把流式路径也走一遍
      const chunks = answer.length > 6 ? [answer.slice(0, 6), answer.slice(6)] : [answer];
      let text = '';
      for (const chunk of chunks) {
        text += chunk;
        handlers.onDelta?.({ delta: chunk });
      }
      return { text, aborted: false };
    },
    async probe() {
      return { ok: true, message: 'perfect-reader 桩（不联网）' };
    },
  };
}

export interface ProbeOutcome {
  id: string;
  answer: string;
  correct: boolean;
  /** 答案里缺的答案键（判分依据，写出来便于人看为什么算错）。 */
  missing: string[];
}

export interface ScoreSummary {
  total: number;
  correct: number;
  rate: number;
  outcomes: ProbeOutcome[];
}

/**
 * 判分：答案必须**包含全部答案键**才算对。
 *
 * 这是个字符串判分器 —— 严苛、可能与措辞冲突，但确定性、可审计、不引入第二个模型。
 * "引用正确"这一项需要答案里带上源消息的标识；**今天的装配没有把消息 id 交给模型**，
 * 所以现在只能判"事实对不对"，判不了"引用对不对"（见 docs/M4-STATUS.md）。
 */
export function scoreProbes(probes: readonly Probe[], answers: ReadonlyMap<string, string>): ScoreSummary {
  const outcomes = probes.map((probe) => {
    const answer = answers.get(probe.id) ?? '';
    const missing = answer.includes(probe.fact) ? [] : [probe.fact];
    return { id: probe.id, answer, correct: missing.length === 0, missing };
  });
  const correct = outcomes.filter((outcome) => outcome.correct).length;
  return { total: outcomes.length, correct, rate: outcomes.length === 0 ? 0 : correct / outcomes.length, outcomes };
}
