/**
 * 把应用状态 + 会话工作区翻译成新装配器（`buildChatRequestV2`）的入参。
 *
 * 单独成文件的两个原因：聊天页已经贴着 400 行上限；而且这段"状态 → 装配输入"的映射
 * 值得被单独测试（不用渲染 React）。
 */

import type { AssembleFn } from '../../../../plugins/writing-pipeline/src/index.ts';
import type { AppState } from '../app/state.ts';
import type { WorkspaceSnapshot } from '../app/workspace.ts';
import { emptyRuntime, setupOfLegacySession } from '../data/card-fallback.ts';
import type { PromptSummary } from '../data/prompt-blocks.ts';
import type { BuildChatRequestV2Options } from '../data/prompt-v2.ts';

export interface ChatOptionsInput {
  state: AppState;
  sessionId: string;
  workspace: WorkspaceSnapshot | undefined;
  summaries?: readonly PromptSummary[];
  preselectedSummaries?: readonly PromptSummary[];
  assemble?: AssembleFn;
}

export function buildChatOptionsV2(input: ChatOptionsInput): BuildChatRequestV2Options {
  const session = input.state.sessions.find((item) => item.id === input.sessionId);
  const setup = input.workspace?.setup ?? (session === undefined ? undefined : setupOfLegacySession(session));
  const members = setup?.characters ?? [];
  const options: BuildChatRequestV2Options = {
    cite: true,
    settings: input.state.settings,
    sessionTitle: session?.title ?? '',
    // 没有 setup 也要能发请求：空成员 + 空处境，由装配器按"最小输入"处理
    setup: setup ?? { characters: [], premise: '', opening_mode: 'designated', origin: 'card' },
    cards: input.workspace?.cards ?? [],
    runtime: input.workspace?.runtime ?? emptyRuntime(),
    history: input.state.messages.map((message) => ({
      role: message.role,
      content: message.content,
      status: message.status,
    })),
    memories: input.state.memories.filter(
      (memory) => memory.characterId === '' || members.includes(memory.characterId),
    ),
    ...(input.summaries === undefined ? {} : { summaries: [...input.summaries] }),
    ...(input.preselectedSummaries === undefined
      ? {}
      : { preselectedSummaries: [...input.preselectedSummaries] }),
    ...(input.assemble === undefined ? {} : { assemble: input.assemble }),
  };
  return options;
}
