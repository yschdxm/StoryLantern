import { useState, type ReactNode } from 'react';
import { describeError } from '../data/error-text.ts';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import type { Memory } from '../data/types.ts';
import { candidatesFor, targetLabel } from '../data/model-routing.ts';
import { PROPOSAL_INSTRUCTION, buildProposalMessages, parseProposals, proposalToDraft, type MemoryProposal } from '../data/memory-proposals.ts';
import { Banner, Button, ConfirmDialog, EmptyState, Field, ListRow, Sheet, SheetItem, TextInput } from '../ui/components.tsx';

/**
 * 长期记忆列表（按角色）。
 *
 * 记忆是**内容**：进 op 日志、跟着同步走，因此这里做的就是普通增删改。
 * 两条刻意的设计：
 *  - 每条都显示来源（用户手写 / 整理建议）与重要度——用户要能分辨"谁写进去的"；
 *  - 没写关键词的记忆会被当作"常量"（每轮都在场），界面把这句话说清楚，
 *    否则用户会以为它坏了。
 */
export function MemoriesScreen({ store, characterId, chat }: MemoriesScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const character = state.characters.find((item) => item.id === characterId);
  const [editing, setEditing] = useState<Memory | 'new' | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined);
  const [organizing, setOrganizing] = useState(false);
  const [organizeError, setOrganizeError] = useState<string | undefined>(undefined);
  const [proposals, setProposals] = useState<{ items: MemoryProposal[]; sessionId: string; picked: boolean[] } | undefined>(
    undefined,
  );

  const mine = state.memories
    .filter((memory) => memory.characterId === characterId || memory.characterId === '')
    .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);

  const menu = mine.find((memory) => memory.id === menuFor);
  const deleting = mine.find((memory) => memory.id === confirmDelete);
  // 这个角色最近的会话（整理的材料来自它）
  const session = state.sessions
    .filter((item) => item.characterId === characterId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];

  /**
   * 整理：让模型给出**建议**，用户确认后才写。
   *
   * 三件事刻意分开：候选模型（多模型路由的 summary 任务）、解析（扛坏输出）、落地（用户勾选）。
   * 任何一步失败都如实说出来，不猜、不自动写入。
   */
  const organize = async (): Promise<void> => {
    setOrganizeError(undefined);
    setOrganizing(true);
    try {
      if (session === undefined) throw new Error(t('memory.organize.noSession'));
      const candidates = candidatesFor(store.getState().settings, 'summary');
      if (candidates.length === 0) throw new Error(t('memory.organize.noModel'));

      const history = await store.actions.messagesOf(session.id);
      const messages = buildProposalMessages({
        characterName: character?.name ?? '',
        history: history.map((message) => ({ role: message.role, content: message.content, status: message.status })),
        existing: mine,
      });

      let raw: string | undefined;
      const errors: string[] = [];
      for (const candidate of candidates) {
        try {
          const result = await chat.reply(
            {
              ...(candidate.id === '' ? {} : { profileId: candidate.id }),
              messages,
              systemPrompt: PROPOSAL_INSTRUCTION,
            },
            {},
          );
          raw = result.text;
          break;
        } catch (cause) {
          errors.push(`${targetLabel(candidate)}：${describeError(cause)}`);
        }
      }
      if (raw === undefined) throw new Error(errors.join(' / '));

      const items = parseProposals(raw, { existing: mine });
      if (items.length === 0) throw new Error(t('memory.organize.empty'));
      setProposals({ items, sessionId: session.id, picked: items.map((item) => item.duplicateOf === undefined) });
    } catch (cause) {
      setOrganizeError(describeError(cause));
    } finally {
      setOrganizing(false);
    }
  };

  const adopt = async (): Promise<void> => {
    const current = proposals;
    if (current === undefined) return;
    setProposals(undefined);
    setOrganizing(true);
    try {
      const history = await store.actions.messagesOf(current.sessionId);
      const messageIds = history.slice(-60).map((message) => message.id);
      for (const [index, proposal] of current.items.entries()) {
        if (current.picked[index] !== true) continue;
        await store.actions.saveMemory(proposalToDraft(proposal, { characterId, sessionId: current.sessionId, messageIds }));
      }
    } catch (cause) {
      setOrganizeError(describeError(cause));
    } finally {
      setOrganizing(false);
    }
  };

  return (
    <>
      <p className="muted">{t('memory.hint', { name: character?.name ?? '' })}</p>

      {organizeError !== undefined && <Banner tone="error">{organizeError}</Banner>}
      {session !== undefined && (
        <div className="row">
          <Button variant="ghost" disabled={organizing || !chat.available} onClick={() => void organize()}>
            {organizing ? t('memory.organize.running') : t('memory.organize')}
          </Button>
        </div>
      )}

      {mine.length === 0 ? (
        <EmptyState
          icon="book"
          title={t('memory.empty.title')}
          hint={t('memory.empty.hint')}
          action={<Button onClick={() => setEditing('new')}>{t('memory.new')}</Button>}
        />
      ) : (
        <>
          <ul className="list">
            {mine.map((memory) => (
              <ListRow
                key={memory.id}
                title={memory.text.length > 40 ? `${memory.text.slice(0, 40)}…` : memory.text}
                subtitle={
                  memory.keys.length === 0 ? t('memory.constant') : memory.keys.map((key) => `#${key}`).join(' ')
                }
                meta={[
                  memory.characterId === '' ? t('lore.scope.global') : (character?.name ?? ''),
                  t('memory.importance', { value: memory.importance }),
                  memory.createdBy === 'agent' ? t('memory.by.agent') : '',
                ]
                  .filter((part) => part !== '')
                  .join(' · ')}
                onClick={() => setEditing(memory)}
                onLongPress={() => setMenuFor(memory.id)}
              />
            ))}
          </ul>
          <div className="row">
            <Button onClick={() => setEditing('new')}>{t('memory.new')}</Button>
          </div>
        </>
      )}

      <Sheet
        open={editing !== undefined}
        title={editing === 'new' ? t('memory.new') : t('memory.edit')}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <MemoryForm
            memory={editing === 'new' ? undefined : editing}
            characterId={characterId}
            characterName={character?.name ?? ''}
            onSubmit={async (draft) => {
              await store.actions.saveMemory(draft);
              setEditing(undefined);
            }}
          />
        )}
      </Sheet>

      <Sheet open={menu !== undefined} title={menu?.text.slice(0, 24)} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="edit"
          label={t('memory.edit')}
          onClick={() => {
            const memory = menu;
            setMenuFor(undefined);
            if (memory !== undefined) setEditing(memory);
          }}
        />
        <SheetItem
          icon="trash"
          label={t('common.delete')}
          danger
          onClick={() => {
            const id = menu?.id;
            setMenuFor(undefined);
            setConfirmDelete(id);
          }}
        />
      </Sheet>

      <ConfirmDialog
        open={deleting !== undefined}
        title={t('memory.delete.title')}
        message={t('memory.delete.message')}
        confirmLabel={t('common.delete')}
        onCancel={() => setConfirmDelete(undefined)}
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(undefined);
          if (id !== undefined) void store.actions.deleteMemory(id);
        }}
      />

      {/* 整理建议：agent 只提建议，勾选与落地都由用户决定 */}
      <Sheet
        open={proposals !== undefined}
        title={t('memory.organize.title', { count: proposals?.picked.filter(Boolean).length ?? 0 })}
        onClose={() => setProposals(undefined)}
      >
        {proposals !== undefined && (
          <>
            <p className="muted">{t('memory.organize.hint')}</p>
            <ul className="list">
              {proposals.items.map((item, index) => (
                <ListRow
                  key={`${item.text}-${index}`}
                  title={item.text}
                  subtitle={item.keys.length === 0 ? t('memory.constant') : item.keys.map((key) => `#${key}`).join(' ')}
                  meta={
                    item.duplicateOf === undefined
                      ? t('memory.importance', { value: item.importance })
                      : t('memory.organize.duplicate')
                  }
                  trailing={proposals.picked[index] === true ? '✓' : ''}
                  onClick={() =>
                    setProposals((current) =>
                      current === undefined
                        ? current
                        : { ...current, picked: current.picked.map((value, at) => (at === index ? !value : value)) },
                    )
                  }
                />
              ))}
            </ul>
            <div className="row">
              <Button disabled={organizing} onClick={() => void adopt()}>
                {t('memory.organize.adopt')}
              </Button>
              <Button variant="ghost" onClick={() => setProposals(undefined)}>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        )}
      </Sheet>
    </>
  );
}

export interface MemoriesScreenProps extends ScreenProps {
  /** 看哪个角色的记忆（来自路由）。 */
  characterId: string;
}

function MemoryForm({
  memory,
  characterId,
  characterName,
  onSubmit,
}: {
  memory?: Memory | undefined;
  characterId: string;
  characterName: string;
  onSubmit: (draft: {
    id?: string;
    characterId?: string;
    text: string;
    keys?: string[];
    importance?: number;
    createdBy?: 'user' | 'agent';
  }) => Promise<void>;
}): ReactNode {
  const t = useT();
  const [text, setText] = useState(memory?.text ?? '');
  const [keys, setKeys] = useState(memory?.keys.join('，') ?? '');
  const [importance, setImportance] = useState(String(memory?.importance ?? 50));
  // 新建默认绑定到当前角色；已有记忆沿用原来的归属
  const [scope, setScope] = useState<'character' | 'global'>(
    memory === undefined ? 'character' : memory.characterId === '' ? 'global' : 'character',
  );
  const [error, setError] = useState<string | undefined>(undefined);

  const split = (value: string): string[] =>
    value
      .split(/[，,、\n]/)
      .map((part) => part.trim())
      .filter((part) => part !== '');

  return (
    <div className="sheet__form">
      <Field label={t('memory.text')} hint={t('memory.text.hint')}>
        <textarea className="input" rows={3} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      <Field label={t('memory.keys')} hint={t('memory.keys.hint')}>
        <TextInput value={keys} onChange={setKeys} placeholder="水，河" />
      </Field>
      <Field label={t('memory.importance.label')} hint={t('memory.importance.hint')}>
        <TextInput type="number" value={importance} onChange={setImportance} />
      </Field>
      <Field label={t('memory.scope')}>
        <div className="segmented" role="group">
          <button
            type="button"
            className={`segmented__item${scope === 'character' ? ' segmented__item--active' : ''}`}
            aria-pressed={scope === 'character'}
            onClick={() => setScope('character')}
          >
            {characterName === '' ? t('memory.scope.character') : characterName}
          </button>
          <button
            type="button"
            className={`segmented__item${scope === 'global' ? ' segmented__item--active' : ''}`}
            aria-pressed={scope === 'global'}
            onClick={() => setScope('global')}
          >
            {t('lore.scope.global')}
          </button>
        </div>
      </Field>

      {error !== undefined && <p className="notice notice--warn">{error}</p>}

      <div className="row">
        <Button
          onClick={() => {
            void onSubmit({
              ...(memory === undefined ? {} : { id: memory.id }),
              ...(scope === 'global' ? {} : { characterId }),
              text,
              keys: split(keys),
              importance: Number(importance) || 50,
              createdBy: memory?.createdBy ?? 'user',
            }).catch((cause: unknown) => setError(describeError(cause)));
          }}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
