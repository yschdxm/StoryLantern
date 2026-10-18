/**
 * 只读工具（tier = `restrict`）：直接读仓储/本机状态，不写任何数据。
 *
 * 每个工具都：① 参数由 registry 统一按 schema 校验；② 返回 JSON 可序列化结构；
 * ③ 查不到就明确说"没有/为什么"，不编造内容（Agent 的错误最贵）。
 */

import type { Message } from './types.ts';
import type { RequestLogEntry } from './request-log.ts';
import type { AgentToolDefinition, AgentToolDeps } from './agent-tool-types.ts';

const EXCERPT_CHARS = 160;
const REQUEST_BODY_PREVIEW = 2000;

function codePoints(text: string): number {
  return Array.from(text).length;
}

function excerpt(content: string, query: string): string {
  const lower = content.toLowerCase();
  const at = lower.indexOf(query.toLowerCase());
  const start = at <= 0 ? 0 : Math.max(0, at - 40);
  const text = content.slice(start, start + EXCERPT_CHARS).replace(/\s+/g, ' ').trim();
  return start === 0 ? text : `…${text}`;
}

async function messagesOf(deps: AgentToolDeps, sessionId: string | undefined): Promise<readonly Message[]> {
  if (sessionId !== undefined && sessionId !== '') return deps.store.actions.messagesOf(sessionId);
  return deps.store.getState().messages;
}

function messageView(message: Message): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    createdAt: message.createdAt,
  };
}

function requestView(entry: RequestLogEntry): Record<string, unknown> {
  const body = entry.body.length > REQUEST_BODY_PREVIEW ? `${entry.body.slice(0, REQUEST_BODY_PREVIEW)}\n…[truncated]` : entry.body;
  return {
    id: entry.id,
    at: entry.at,
    sessionId: entry.sessionId,
    model: entry.model,
    url: entry.url,
    byteLength: entry.byteLength,
    status: entry.status,
    ...(entry.firstDeltaMs === undefined ? {} : { firstDeltaMs: entry.firstDeltaMs }),
    ...(entry.totalMs === undefined ? {} : { totalMs: entry.totalMs }),
    body,
    bodyTruncated: entry.body.length > REQUEST_BODY_PREVIEW,
  };
}

// ---------------------------------------------------------------- 搜索 / 区间

async function searchMessages(args: Readonly<Record<string, unknown>>, deps: AgentToolDeps): Promise<unknown> {
  const query = String(args['query']);
  const sessionId = args['sessionId'] === undefined ? undefined : String(args['sessionId']);
  const limit = args['limit'] === undefined ? 10 : Number(args['limit']);
  const all = await messagesOf(deps, sessionId);
  const needle = query.toLowerCase();
  const hits = all
    .filter((message) => message.content.toLowerCase().includes(needle))
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, limit);
  return {
    query,
    ...(sessionId === undefined ? {} : { sessionId }),
    count: hits.length,
    messages: hits.map((message) => ({
      id: message.id,
      role: message.role,
      excerpt: excerpt(message.content, query),
      createdAt: message.createdAt,
    })),
  };
}

async function readRange(args: Readonly<Record<string, unknown>>, deps: AgentToolDeps): Promise<unknown> {
  const sessionId = String(args['sessionId']);
  const start = args['start'] === undefined ? 0 : Number(args['start']);
  const count = args['count'] === undefined ? 20 : Number(args['count']);
  const all = await deps.store.actions.messagesOf(sessionId);
  const slice = all.slice(start, start + count);
  return {
    sessionId,
    total: all.length,
    start,
    count: slice.length,
    messages: slice.map(messageView),
    ...(slice.length === 0 ? { note: start >= all.length ? '起始序号超出消息总数，没有内容' : '这个区间没有消息' } : {}),
  };
}

// ---------------------------------------------------------------- 摘要 / 请求 / 诊断

async function readSummary(args: Readonly<Record<string, unknown>>, deps: AgentToolDeps): Promise<unknown> {
  const sessionId = String(args['sessionId']);
  const summaries = await deps.store.actions.summariesOf(sessionId);
  return {
    sessionId,
    count: summaries.length,
    summaries: summaries.map((summary) => ({
      id: summary.id,
      level: summary.level,
      text: summary.text,
      covers: [...summary.covers],
      updatedAt: summary.updatedAt,
    })),
    ...(summaries.length === 0 ? { note: '这个会话还没有分层摘要（或已被删除）' } : {}),
  };
}

async function readRequest(args: Readonly<Record<string, unknown>>, deps: AgentToolDeps): Promise<unknown> {
  if (deps.requestLog === undefined) {
    return { available: false, reason: '这个运行没有接入请求审计日志（request.log）' };
  }
  const entries = await deps.requestLog.list();
  const requestLogId = args['requestLogId'] === undefined ? undefined : String(args['requestLogId']);
  if (entries.length === 0) return { available: true, found: false, count: 0, note: '本机还没有请求记录（还没发过消息或已清空）' };
  if (requestLogId !== undefined && requestLogId !== '') {
    const found = entries.find((entry) => entry.id === requestLogId);
    if (found === undefined) return { available: true, found: false, requestLogId, note: '没有这条请求记录（可能已被 FIFO 清掉）' };
    return { available: true, found: true, request: requestView(found) };
  }
  const latest = entries[0];
  return { available: true, found: latest !== undefined, count: entries.length, request: latest === undefined ? null : requestView(latest) };
}

async function diagnoseReply(args: Readonly<Record<string, unknown>>, deps: AgentToolDeps): Promise<unknown> {
  const sessionId = String(args['sessionId']);
  const messageId = args['messageId'] === undefined ? undefined : String(args['messageId']);
  const all = await deps.store.actions.messagesOf(sessionId);
  const target =
    messageId === undefined || messageId === ''
      ? [...all].reverse().find((message) => message.role === 'assistant')
      : all.find((message) => message.id === messageId);
  if (target === undefined) {
    return { available: false, sessionId, note: messageId === undefined ? '这个会话还没有助手消息' : '找不到这条消息（可能已删除）' };
  }
  const meta = target.meta;
  const citations = meta?.citations ?? [];
  return {
    available: true,
    sessionId,
    messageId: target.id,
    status: target.status,
    contentChars: codePoints(target.content),
    model: meta === undefined ? null : { id: meta.modelId ?? null, label: meta.modelLabel ?? null },
    timing: meta?.timing ?? null,
    tokens: meta?.tokens ?? null,
    citations: {
      count: citations.length,
      resolved: citations.filter((citation) => citation.resolved).length,
      unresolved: citations.filter((citation) => !citation.resolved).length,
    },
    regex: meta?.regex ?? [],
    reasoningChars: meta?.reasoning === undefined ? 0 : codePoints(meta.reasoning),
    ...(meta === undefined ? { note: '这条消息没有生成元数据（旧消息或不是模型生成）' } : {}),
  };
}

// ---------------------------------------------------------------- 规则批评

const REPEAT_WINDOW = 6;

function topRepeatedBigram(text: string): { phrase: string; count: number } {
  const counts = new Map<string, number>();
  const chars = Array.from(text.replace(/\s+/g, ''));
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const phrase = `${chars[index]}${chars[index + 1]}`;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  let best = { phrase: '', count: 0 };
  for (const [phrase, count] of counts) {
    if (count > best.count) best = { phrase, count };
  }
  return best;
}

async function critiqueText(args: Readonly<Record<string, unknown>>): Promise<unknown> {
  const text = String(args['text']);
  const chars = codePoints(text);
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const sentences = text.split(/[。！？!?.\n]+/).map((part) => part.trim()).filter((part) => part !== '');
  const sentenceChars = sentences.map((sentence) => codePoints(sentence));
  const averageSentence = sentenceChars.length === 0 ? 0 : Math.round(sentenceChars.reduce((sum, value) => sum + value, 0) / sentenceChars.length);
  const repeated = topRepeatedBigram(text);
  const secondPerson = (text.match(/[你您]/g) ?? []).length;
  const findings: Array<{ code: string; severity: 'info' | 'warning'; detail: string }> = [];
  if (chars < 80) findings.push({ code: 'length.very-short', severity: 'warning', detail: `只有 ${chars} 字，可能撑不起一个场景` });
  if (chars > 2000) findings.push({ code: 'length.very-long', severity: 'info', detail: `${chars} 字偏长，检查是否有可删的复述` });
  if (repeated.count >= REPEAT_WINDOW) findings.push({ code: 'repetition.phrase', severity: 'warning', detail: `短语「${repeated.phrase}」重复 ${repeated.count} 次` });
  if (averageSentence > 40) findings.push({ code: 'rhythm.long-sentence', severity: 'warning', detail: `平均句长 ${averageSentence} 字，节奏偏慢` });
  if (secondPerson === 0) findings.push({ code: 'perspective.no-second-person', severity: 'info', detail: '全文没有第二人称，检查视角是否偏离' });
  if (lines.length === 1 && chars > 200) findings.push({ code: 'format.no-line-break', severity: 'info', detail: '整段没有换行，长回复建议分段' });
  return {
    ruleBased: true,
    note: '这是确定性的规则检查，不是模型判断；只作为修改线索，不评价文采与剧情。',
    metrics: { chars, lines: lines.length, sentences: sentences.length, averageSentenceChars: averageSentence, repeatedPhrase: repeated, secondPerson },
    findings,
  };
}

export function createReadTools(deps: AgentToolDeps): AgentToolDefinition[] {
  return [
    {
      name: 'searchMessages',
      description: '按关键词检索消息（大小写不敏感），返回 id/角色/摘要/时间。用于找"那句话到底在哪一轮"。',
      tier: 'restrict',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1, description: '要搜索的关键词' },
          sessionId: { type: 'string', description: '会话 id；不传则搜当前会话消息' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多返回几条（默认 10）' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: (args) => searchMessages(args, deps),
    },
    {
      name: 'readRange',
      description: '读取某个会话的一段消息（按创建顺序），用于回看上下文。',
      tier: 'restrict',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1 },
          start: { type: 'integer', minimum: 0, description: '起始下标（0 起）' },
          count: { type: 'integer', minimum: 1, maximum: 200, description: '条数（默认 20）' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      execute: (args) => readRange(args, deps),
    },
    {
      name: 'readSummary',
      description: '读取某个会话的分层摘要（scene/arc/session）。',
      tier: 'restrict',
      parameters: {
        type: 'object',
        properties: { sessionId: { type: 'string', minLength: 1 } },
        required: ['sessionId'],
        additionalProperties: false,
      },
      execute: (args) => readSummary(args, deps),
    },
    {
      name: 'readRequest',
      description: '读取本机请求审计日志里的真实请求（最近一条或指定 id），用于回答"模型实际看到了什么"。',
      tier: 'restrict',
      parameters: {
        type: 'object',
        properties: { requestLogId: { type: 'string', description: '不传则取最近一条' } },
        additionalProperties: false,
      },
      execute: (args) => readRequest(args, deps),
    },
    {
      name: 'diagnoseReply',
      description: '诊断最后一条助手消息（或指定消息）：模型/耗时/token/引用/正则统计。',
      tier: 'restrict',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1 },
          messageId: { type: 'string', description: '不传则取最后一条助手消息' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      execute: (args) => diagnoseReply(args, deps),
    },
    {
      name: 'critiqueText',
      description: '对一段文本做**规则**批评（长度/重复/句长/视角/分段），不是模型判断。',
      tier: 'restrict',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1 } },
        required: ['text'],
        additionalProperties: false,
      },
      execute: (args) => critiqueText(args),
    },
  ];
}
