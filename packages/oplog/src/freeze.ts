import type { Snapshot } from './state-types.ts';

/**
 * 把快照规范化成稳定的字符串，便于"两个副本是否收敛"这类断言。
 *
 * 关键点：**先排序再序列化**。物化状态里的对象/数组顺序取决于 op 到达顺序，
 * 直接 `JSON.stringify` 会得出不同字符串，从而把"顺序不同"误报成"状态不同"。
 */
export function freezeSnapshot(snapshot: Snapshot): string {
  return JSON.stringify({
    version: snapshot.version,
    sessions: Object.fromEntries(
      Object.entries(snapshot.state.sessions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, session]) => [id, { ...session }]),
    ),
    messages: Object.fromEntries(
      Object.entries(snapshot.state.messages)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, message]) => [
          id,
          {
            ...message,
            revisions: [...message.revisions].sort((a, b) => a.revisionId.localeCompare(b.revisionId)),
            candidates: [...message.candidates].sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
          },
        ]),
    ),
    settings: Object.fromEntries(
      Object.entries(snapshot.state.settings)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value]),
    ),
    appliedOpIds: [...snapshot.appliedOpIds].sort(),
  });
}
