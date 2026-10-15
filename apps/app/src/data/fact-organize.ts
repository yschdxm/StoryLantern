import { parseFactProposals, type FactProposal } from '../../../../packages/oplog/src/index.ts';
import { candidatesFor, targetLabel } from './model-routing.ts';
import { describeError } from './error-text.ts';
import type { Fact, FactDraft } from './fact-types.ts';
import type { MessageRole } from './types.ts';

/**
 * 设定库抽取的**编排**（纯逻辑，不碰仓储）：把最近对话编号交给模型，让它按格式吐事实，
 * 再把"第几条"换算成真正的消息 id（**provenance 必须落到真实消息上**）。
 *
 * 关键设计：
 *  - 对话**带序号**（[1] [2] …）：模型只会说"第 3 条"，所以序号→id 的换算必须由我们做，
 *    并且**越界的序号直接丢掉那条提议**（宁可少一条，也不能编一个来源）；
 *  - 与已有事实**去重**（同主语+同谓词+同宾语视为同一条）：避免反复抽取把界面塞满；
 *  - 产物一律是 `state: 'proposed'`：采纳/拒绝是人的决定，不替用户拍板。
 */

export const FACT_INSTRUCTION = [
  '你是一个设定整理助手。请从下面带序号的对话里，抽出**已经确立**的事实（谁是谁、什么是什么、发生了什么）。',
  '只输出一个 JSON 数组，不要任何解释、不要代码块以外的文字。每一项形如：',
  '{"subject":"主语（人或物）","predicate":"谓语（关系或属性，如 身份/来历/地点）","object":"宾语（具体内容）",',
  '"text":"一句人话（可选）","sources":[1,3],"confidence":80}',
  '要求：sources 里是**对话序号**（方括号里的数字），必须真的支持这条事实；没有依据就不要写这一条。',
  '只整理、不发挥：不要推测，不要把设定写成小说。',
].join('\n');

export interface FactOrganizeInput {
  settings: Record<string, string>;
  characterId?: string;
  /** 给模型看的对话（最近的若干条）。 */
  history: readonly { id: string; role: MessageRole; content: string }[];
  /** 已有事实（用于去重）。 */
  existing: readonly Fact[];
  /** 用某个模型配置生成（界面传入：真机上就是聊天客户端）。 */
  reply: (profileId: string | undefined, systemPrompt: string, userText: string) => Promise<string>;
  /** 最多看最近多少条对话（默认 40，与上下文窗口一致）。 */
  window?: number;
}

export interface FactOrganizeResult {
  drafts: FactDraft[];
  /** 因为格式不对、来源越界或没有来源而丢掉的条数（界面要显示，不能假装模型没给）。 */
  dropped: number;
  /** 去重掉了几条（同主语同谓词同宾语）。 */
  duplicated: number;
}

/** 宽容剥代码块：模型爱把 JSON 包起来（真正的字段校验交给 oplog 的 parseFactProposals）。 */
function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```[a-zA-Z]*\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  return trimmed;
}

interface RawItem {
  subject?: unknown;
  predicate?: unknown;
  object?: unknown;
  text?: unknown;
  sources?: unknown;
  sourceMessageIds?: unknown;
  confidence?: unknown;
}

/**
 * 把"序号数组"换写成 oplog 校验器认的 `sourceMessageIds`，再交给它统一校验 —— 只保留一套校验规则。
 */
function toValidatorShape(raw: string): { json: string; error?: string } {
  const body = stripFences(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { json: '[]', error: '模型返回的不是合法 JSON（可以要求它只输出 JSON 数组）' };
  }
  const items = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(items)) return { json: '[]', error: 'JSON 顶层应当是数组' };
  const rewritten = items.map((item) => {
    const entry = item as RawItem;
    const sources = Array.isArray(entry.sources) ? entry.sources : entry.sourceMessageIds;
    return { ...entry, sourceMessageIds: Array.isArray(sources) ? sources.map((value) => String(value)) : [] };
  });
  return { json: JSON.stringify(rewritten) };
}

/** 序号（1 起）→ 消息 id；越界返回 undefined（丢这条，不编来源）。 */
function idOfIndex(index: number, window: readonly { id: string }[]): string | undefined {
  const position = index - 1;
  if (!Number.isInteger(position) || position < 0 || position >= window.length) return undefined;
  return window[position]?.id;
}

export async function recomputeFacts(input: FactOrganizeInput): Promise<FactOrganizeResult> {
  const window = input.history.slice(-(input.window ?? 40));
  if (window.length === 0) return { drafts: [], dropped: 0, duplicated: 0 };

  const candidates = candidatesFor(input.settings, 'extract');
  if (candidates.length === 0) throw new Error('no-model');

  const transcript = window
    .map((message, index) => `[${index + 1}] ${message.role === 'user' ? '旅人' : '星野'}：${message.content}`)
    .join('\n');

  const errors: string[] = [];
  let parsed: { proposals: FactProposal[]; dropped: number } | undefined;
  for (const candidate of candidates) {
    try {
      const raw = await input.reply(candidate.id === '' ? undefined : candidate.id, FACT_INSTRUCTION, transcript);
      const shape = toValidatorShape(raw);
      if (shape.error !== undefined) throw new Error(shape.error);
      const result = parseFactProposals(shape.json);
      if (result.error !== undefined) throw new Error(result.error);
      parsed = { proposals: result.proposals, dropped: result.dropped };
      break;
    } catch (cause) {
      errors.push(`${targetLabel(candidate)}：${describeError(cause)}`);
    }
  }
  if (parsed === undefined) throw new Error(errors.join(' / '));

  const existingKeys = new Set(input.existing.map((fact) => `${fact.subject}\u0000${fact.predicate}\u0000${fact.object}`));
  const drafts: FactDraft[] = [];
  let dropped = parsed.dropped;
  let duplicated = 0;
  for (const proposal of parsed.proposals) {
    const sourceIds: string[] = [];
    for (const rawId of proposal.sourceMessageIds) {
      const resolved = idOfIndex(Number.parseInt(rawId, 10), window);
      if (resolved !== undefined) sourceIds.push(resolved);
    }
    if (sourceIds.length === 0) {
      // 来源越界或指不到真实消息：丢掉这条，**不编一个来源**
      dropped += 1;
      continue;
    }
    const key = `${proposal.subject}\u0000${proposal.predicate}\u0000${proposal.object}`;
    if (existingKeys.has(key)) {
      duplicated += 1;
      continue;
    }
    existingKeys.add(key);
    drafts.push({
      factId: `fact-${proposal.subject}-${proposal.predicate}-${proposal.object}-${sourceIds[0] ?? ''}`.slice(0, 120),
      ...(input.characterId === undefined || input.characterId === '' ? {} : { characterId: input.characterId }),
      subject: proposal.subject,
      predicate: proposal.predicate,
      object: proposal.object,
      ...(proposal.text === undefined ? {} : { text: proposal.text }),
      sourceMessageIds: sourceIds,
      ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }),
      state: 'proposed',
      createdBy: 'model',
      ...(candidates[0] === undefined || candidates[0].id === '' ? {} : { modelId: candidates[0].id }),
    });
  }

  return { drafts, dropped, duplicated };
}
