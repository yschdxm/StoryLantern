import type { Snapshot } from './state-types.ts';

/**
 * 把快照规范化成稳定的字符串，便于"两个副本是否收敛"这类断言。
 *
 * 关键点：**先排序再序列化**。物化状态里的对象/数组顺序取决于 op 到达顺序，
 * 直接 `JSON.stringify` 会得出不同字符串，从而把"顺序不同"误报成"状态不同"。
 *
 * 覆盖**全部**实体表（卡片模型加进来后，少了任何一张表，收敛断言就会漏掉那部分数据）。
 * 数组类记录（消息的 revisions/candidates、运行时的补丁序列）在比较前也要排序：
 * 补丁虽已按 HLC 插入，但这里再按 opId 排一次，避免将来插入策略变化时断言失真。
 */
export function freezeSnapshot(snapshot: Snapshot): string {
  const state = snapshot.state;
  const sortedEntries = <T>(record: Record<string, T>): Array<[string, T]> =>
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({
    version: snapshot.version,
    characters: Object.fromEntries(
      sortedEntries(state.characters).map(([id, character]) => [
        id,
        {
          ...character,
          ...(character.alternateGreetings === undefined
            ? {}
            : { alternateGreetings: [...character.alternateGreetings] }),
        },
      ]),
    ),
    sessions: Object.fromEntries(sortedEntries(state.sessions)),
    messages: Object.fromEntries(
      sortedEntries(state.messages).map(([id, message]) => [
        id,
        {
          ...message,
          revisions: [...message.revisions].sort((a, b) => a.revisionId.localeCompare(b.revisionId)),
          candidates: [...message.candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
        },
      ]),
    ),
    lorebooks: Object.fromEntries(sortedEntries(state.lorebooks)),
    memories: Object.fromEntries(sortedEntries(state.memories)),
    summaries: Object.fromEntries(sortedEntries(state.summaries)),
    facts: Object.fromEntries(sortedEntries(state.facts)),
    settings: Object.fromEntries(sortedEntries(state.settings)),
    cards: Object.fromEntries(sortedEntries(state.cards)),
    setups: Object.fromEntries(sortedEntries(state.setups)),
    runtimePatches: Object.fromEntries(
      sortedEntries(state.runtimePatches).map(([sessionId, patches]) => [
        sessionId,
        [...patches].sort((a, b) => a.opId.localeCompare(b.opId)),
      ]),
    ),
    packs: Object.fromEntries(sortedEntries(state.packs)),
    stash: Object.fromEntries(sortedEntries(state.stash)),
    cardLibrary: Object.fromEntries(sortedEntries(state.cardLibrary)),
    appliedOpIds: [...snapshot.appliedOpIds].sort(),
  });
}
