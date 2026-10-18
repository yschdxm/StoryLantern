import { DataError, type MessageDraft, type Repository } from './repository.ts';
import type { Session } from './types.ts';

/**
 * 会话分叉（B17）：复制 setup + 当前全部消息，生成一个 `forkedFrom` 指向原会话的新会话。
 *
 * 三条边界：
 *  - **原会话只读**：只 `list`，不写任何 op；
 *  - **消息复制用批量写**：一条 `appendMany`，不是逐条（真机上逐条会慢到不可用）；
 *  - **runtime 不复制**：runtime 是补丁序列，携带 `caused_by_message_id` 等因果引用，
 *    直接搬过去可能指向新会话里不存在的消息。新会话按同一份 setup 派生默认运行时；
 *    需要迁移时由调用方显式 `runtime.patch`（不在这里假装复制成功）。
 */
export async function forkSessionInRepository(
  repository: Repository,
  sessionId: string,
  options: { title?: string } = {},
): Promise<Session> {
  const sessions = await repository.sessions.list();
  const original = sessions.find((session) => session.id === sessionId);
  if (original === undefined) throw new DataError('not-found', '要分叉的会话不存在');

  const setup = repository.setups === undefined ? undefined : await repository.setups.get(sessionId);
  const fromSetup = (setup?.characters ?? []).map((id) => id.trim()).filter((id) => id !== '');
  const characterIds = fromSetup.length > 0 ? fromSetup : original.characterId === '' ? [] : [original.characterId];
  if (characterIds.length === 0) throw new DataError('invalid-argument', '原会话没有成员，无法分叉');

  const title = (options.title ?? `${original.title}（分叉）`).trim().slice(0, 120) || original.title;
  let created: Session;
  if (setup !== undefined && repository.sessions.createWithSetup !== undefined) {
    // createWithSetup 会按 opening_mode 写开场消息；分叉要复制完整历史，先压成 self 再恢复原 setup
    created = await repository.sessions.createWithSetup({
      characterIds,
      setup: { ...setup, opening_mode: 'self' },
      title,
      forkedFrom: sessionId,
    });
    if (repository.setups !== undefined) await repository.setups.save(created.id, setup);
  } else {
    // 最小实现（浏览器内存仓储）没有 setup：仍复制消息，只是 forkedFrom/来源 setup 不可用
    created = await repository.sessions.create(characterIds[0] as string, title);
  }

  const messages = await repository.messages.list(sessionId);
  const drafts: MessageDraft[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.createdAt <= 0 ? {} : { createdAt: message.createdAt }),
    status: message.status === 'streaming' ? 'done' : message.status,
    ...(message.meta === undefined ? {} : { meta: message.meta }),
    ...(message.candidates.length === 0 ? {} : { candidates: message.candidates.map((candidate) => candidate.content) }),
  }));
  if (drafts.length > 0) await repository.messages.appendMany(created.id, drafts);

  // 批量写完重读一次摘要（messageCount/lastMessage），不逐条刷新
  const refreshed = (await repository.sessions.list()).find((session) => session.id === created.id);
  return refreshed ?? created;
}
