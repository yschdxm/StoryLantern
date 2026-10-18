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
import type { PromptSummary } from '../data/prompt-blocks-v2.ts';
import type { BuildChatRequestV2Options } from '../data/prompt-v2.ts';
import { SETTING_KEYS } from '../data/types.ts';

/** 真实用量回传：默认开；只有显式 `chat.stream_usage='off'` 才关（改用估算）。 */
export function includeUsageOf(settings: Record<string, string>): boolean {
  return settings[SETTING_KEYS.streamUsage] !== 'off';
}

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
    // 引用编号默认关闭：普通角色扮演不应该突然出现 [16]；设置里显式开启才编号。
    cite: input.state.settings[SETTING_KEYS.cite] === 'on',
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
      // id 是引用窗口把 [n] 换算回消息的唯一依据；不带 id 的旧数据不伪造
      id: message.id,
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
