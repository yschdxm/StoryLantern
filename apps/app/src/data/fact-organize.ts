import { cosineSimilarity, parseFactProposals, type FactProposal } from '../../../../packages/oplog/src/index.ts';
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
  // 真实模型跑出来的具体毛病（见 DEVELOPMENT.md 第四十八节）：它会把"谁在说话"当成事实
  // （例如「旅人是对话中的发言者」），这类描述**对话本身**的话不是世界观设定，必须在提示里禁掉。
  '只抽**故事世界里的设定**：不要把"谁在说话""这段对话讲了什么"这类描述对话本身的话当成事实，也不要成段重复对话原文。',
].join('\n');

/** 近似重复的判定阈值（余弦）。**量出来的**：无关事实两两 0.307，同一句话被模型拆成两三条时约 0.709～0.824（第四十八节）。 */
export const NEAR_DUPLICATE = 0.65;

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
  /**
   * 可选的系统提示：默认用仓库里那条 FACT_INSTRUCTION。留出这个口子是为了让评估能
   * 拿**旧提示**跑同样多次数，做同等样本的前后对比（否则前后样本量不等，比出来的不算数）。
   */
  instruction?: string;
  /**
   * 可选的向量源：给了就做**近似重复合并**（同一句话被拆成两三条时合并成一条）。
   * 不给就**不猜** —— 只保留原来的精确去重（没向量时宁可多留一条，也不要错并两条）。
   */
  embed?: (texts: readonly string[]) => Promise<readonly (readonly number[])[]>;
}

export interface FactOrganizeResult {
  drafts: FactDraft[];
  /** 因为格式不对、来源越界或没有来源而丢掉的条数（界面要显示，不能假装模型没给）。 */
  dropped: number;
  /** 去重掉了几条（同主语同谓词同宾语）。 */
  duplicated: number;
  /** 近似重复合并掉了几条（靠向量；没有向量源时恒为 0）。 */
  merged: number;
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
  if (window.length === 0) return { drafts: [], dropped: 0, duplicated: 0, merged: 0 };

  const candidates = candidatesFor(input.settings, 'extract');
  if (candidates.length === 0) throw new Error('no-model');

  const transcript = window
    .map((message, index) => `[${index + 1}] ${message.role === 'user' ? '旅人' : '星野'}：${message.content}`)
    .join('\n');

  const errors: string[] = [];
  let parsed: { proposals: FactProposal[]; dropped: number } | undefined;
  for (const candidate of candidates) {
    try {
      const raw = await input.reply(candidate.id === '' ? undefined : candidate.id, input.instruction ?? FACT_INSTRUCTION, transcript);
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

  // **近似重复合并**：真实模型会把同一句话拆成两三条（例：`她｜真名｜阿霜` 与
  // `她｜保密状态｜从没跟人说过自己的真名`），而精确去重只比"同主语+同谓语+同宾语"，合不掉它们。
  // 合并规则保守：保留先出现的那条，**来源取并集**（不丢出处）；向量不可用就退回精确去重的结果。
  let kept: FactDraft[] = drafts;
  let merged = 0;
  if (input.embed !== undefined && drafts.length >= 2) {
    try {
      // 用**信息最全的一串**做比较（主语｜谓语｜宾语｜文本）：这也是量具里算余弦用的同一串文本 ——
      // 量具与产品必须比同一个东西，否则阈值标定了也不算数（这一条是被一次"没生效"的实测逼出来的）。
      const texts = drafts.map(
        (draft) => `${draft.subject}｜${draft.predicate}｜${draft.object}｜${draft.text ?? ''}`,
      );
      const vectors = await input.embed(texts);
      kept = [];
      const keptVectors: (readonly number[])[] = [];
      for (let index = 0; index < drafts.length; index += 1) {
        const draft = drafts[index];
        if (draft === undefined) continue;
        const vector = vectors[index] ?? [];
        const nearIndex = keptVectors.findIndex((other) => cosineSimilarity(vector, other) >= NEAR_DUPLICATE);
        if (nearIndex < 0) {
          kept.push(draft);
          keptVectors.push(vector);
          continue;
        }
        const target = kept[nearIndex];
        if (target === undefined) continue;
        kept[nearIndex] = {
          ...target,
          sourceMessageIds: [...new Set([...target.sourceMessageIds, ...draft.sourceMessageIds])],
        };
        merged += 1;
      }
    } catch {
      kept = drafts;
      merged = 0;
    }
  }

  return { drafts: kept, dropped, duplicated, merged };
}
