/**
 * 「引用正确」（M4 判据的第二半）：让模型能**指出**它依据的是哪条消息，然后把它指的对不对判出来。
 *
 * 三件事：
 *  1. \`formatNumbered\` / \`numberedHistory\`：把对话按 \`[1] [2] …\` 编号交给模型
 *     （不编号它就无从指认，判据也就无从判）；
 *  2. \`parseCitationIndices\`：从回答里把 \`[3]\` 这类引用取出来（宽容：\`[3,7]\` 也认，去重、保序）；
 *  3. \`checkCitations\`：把编号换算回**消息 id**，再用调用方给的"这条消息是否支持这个答案"判断，
 *     得出 \`correct\`。**刻意把"没引用"和"引用了但引用错"分开报**——后者更需要被看见。
 *
 * 编号窗口与装配时用的窗口必须一致（都是"最近 N 条"），否则编号会指错人；所以换算由调用方传窗口进来。
 */

export interface NumberedMessage {
  id: string;
  index: number;
  content: string;
}

/** 给一条消息内容加上编号前缀。 */
export function formatNumbered(content: string, index: number): string {
  return `[${index}] ${content}`;
}

/** 按 1 起编号给最近的若干条消息编号（窗口与装配时一致）。 */
export function numberedHistory(messages: readonly { id: string; content: string }[]): NumberedMessage[] {
  return messages.map((message, position) => ({
    id: message.id,
    index: position + 1,
    content: formatNumbered(message.content, position + 1),
  }));
}

/**
 * 从回答里取引用编号：[3] / [3,7] / [3、7] 都认；去重并保持出现顺序。
 * 不认范围（[3-5]）与中文括号——宁可漏判，也不猜。
 */
export function parseCitationIndices(text: string): number[] {
  const found: number[] = [];
  const pattern = /\[(\d+(?:\s*[,、]\s*\d+)*)\]/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const body = match[1] ?? '';
    for (const piece of body.split(/[,、]/)) {
      const value = Number.parseInt(piece.trim(), 10);
      if (Number.isInteger(value) && value > 0 && !found.includes(value)) found.push(value);
    }
    match = pattern.exec(text);
  }
  return found;
}

export type CitationVerdict = 'correct' | 'no-citation' | 'wrong-citation' | 'unresolvable';

export interface CitationCheck {
  verdict: CitationVerdict;
  indices: number[];
  /** 换算出的消息 id（越界的不在里面）。 */
  ids: string[];
  reason: string;
}

/**
 * 引用核对。
 *
 * \`supports\` 由调用方给：它回答"这条消息是否支持这个答案"（评估里用词法检索，产品里可以用事实的 provenance）。
 * 三种结果分开报：
 *  - \`no-citation\`：一个编号都没写（不是错，但"引用正确"这条判据就不成立）；
 *  - \`wrong-citation\`：写的编号里**没有一条**支持这个答案（"答对了但引用错"就是它）；
 *  - \`correct\`：至少一条引用的消息支持这个答案。
 */
export function checkCitations(
  text: string,
  window: readonly { id: string }[],
  supports: (messageId: string) => boolean,
): CitationCheck {
  const indices = parseCitationIndices(text);
  if (indices.length === 0) {
    return { verdict: 'no-citation', indices, ids: [], reason: '回答里没有引用编号' };
  }
  const ids: string[] = [];
  let outOfRange = 0;
  for (const index of indices) {
    const message = window[index - 1];
    if (message === undefined) {
      outOfRange += 1;
      continue;
    }
    ids.push(message.id);
  }
  if (ids.length === 0) {
    return {
      verdict: 'unresolvable',
      indices,
      ids,
      reason: `引用了 ${indices.join('、')}，但这些编号都不在对话窗口里（共 ${window.length} 条）`,
    };
  }
  const supporting = ids.filter((id) => supports(id));
  if (supporting.length === 0) {
    return {
      verdict: 'wrong-citation',
      indices,
      ids,
      reason: `引用了 ${indices.join('、')}，但没有一条支持这个答案`,
    };
  }
  return {
    verdict: 'correct',
    indices,
    ids,
    reason: `引用了 ${indices.join('、')}，其中 ${supporting.length} 条支持这个答案${outOfRange === 0 ? '' : `（另有 ${outOfRange} 个编号越界）`}`,
  };
}

/** 给系统提示用的一句话：怎么引用。 */
export const CITATION_INSTRUCTION =
  '对话里的每条消息都带编号（如 [12]）。回答时，如果依据了某几条消息，请在句末用同样的编号标注，例如「……（[12][13]）」。不确定来源时不要编编号。';
