import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { conflictsOf, factsToLoreEntries, verifyProvenance, type ProvenanceCheck } from '../../../../packages/oplog/src/index.ts';
import { describeError } from '../data/error-text.ts';
import { recomputeFacts } from '../data/fact-organize.ts';
import type { Fact } from '../data/fact-types.ts';
import { useT } from '../i18n/context.tsx';
import { Banner, Button, EmptyState, ListRow, Sheet, SheetItem } from '../ui/components.tsx';
import { useAppState, type ScreenProps } from './screen-props.ts';

/**
 * 设定库（M4）：从对话里抽出的事实，逐条可核对、可采纳/拒绝、可一键导出成世界书条目。
 *
 * 三条界面原则：
 *  - **每条都显示 provenance**（来自哪几条消息）：没有出处的断言不该被信任，所以来源必须看得见；
 *  - **冲突显式提示**（同主语同谓词、不同宾语）：这是"设定打架"最需要人拍板的地方；
 *  - **不替用户拍板**：抽取出来的都是"待定"，采纳/拒绝由人点。
 */
export interface FactsScreenProps extends ScreenProps {
  characterId: string;
}

export function FactsScreen({ store, characterId, chat }: FactsScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);

  const character = state.characters.find((item) => item.id === characterId);
  /**
   * 事实列表**由本屏自己加载**，不读应用状态里的切片。
   *
   * 为什么：切片只在某些动作里刷新，刚启动时是空的 —— 真机上就因此看到"抽取成功但列表还是空"。
   * 界面自己加载一遍，写入后再加载一遍，就不会被别处的刷新时机牵着走。
   */
  const [facts, setFacts] = useState<Fact[]>([]);
  /**
   * provenance 核对（M4）：光有"源消息 id"不算数 —— 还要看那条消息是不是这条事实真正的出处。
   * 核对结果是**派生**的（不落库）：同一批事实在任何设备上算出来都一样。
   */
  const [messages, setMessages] = useState<{ id: string; content: string }[]>([]);
  const reload = useCallback(async (): Promise<void> => {
    setFacts(await store.actions.factsOf(characterId));
    const session = store
      .getState()
      .sessions.filter((item) => item.characterId === characterId)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const history = session === undefined ? [] : await store.actions.messagesOf(session.id);
    setMessages(history.map((message) => ({ id: message.id, content: message.content })));
  }, [store, characterId]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const conflicts = conflictsOf(facts);
  const conflictIds = new Set(conflicts.flatMap((item) => [item.a.factId, item.b.factId]));
  const menu = facts.find((fact) => fact.id === menuFor);

  /** 抽取：让模型按格式给事实 → 全部落成"待定"。去重与来源换算都在 recomputeFacts 里。 */
  const extract = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const session = state.sessions
        .filter((item) => item.characterId === characterId)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      const history = await store.actions.messagesOf(session?.id ?? '');
      if (history.length === 0) throw new Error(t('facts.noHistory'));
      const result = await recomputeFacts({
        settings: store.getState().settings,
        characterId,
        history: history.map((message) => ({ id: message.id, role: message.role, content: message.content })),
        existing: facts,
        reply: (profileId, systemPrompt, userText) =>
          chat
            .reply(
              {
                ...(profileId === undefined ? {} : { profileId }),
                messages: [{ role: 'user', content: userText }],
                systemPrompt,
              },
              {},
            )
            .then((reply) => reply.text),
      });
      if (result.drafts.length === 0) {
        setNote(t('facts.empty', { dropped: result.dropped, duplicated: result.duplicated }));
        return;
      }
      await store.actions.saveFacts(result.drafts);
      await reload();
      setNote(t('facts.extracted', { count: result.drafts.length, dropped: result.dropped, duplicated: result.duplicated }));
    } catch (cause) {
      const message = describeError(cause);
      setError(message === 'no-model' ? t('memory.organize.noModel') : message);
    } finally {
      setBusy(false);
    }
  };

  /** 改状态（采纳/拒绝）：同一条 factId 再写一次，状态不同。 */
  const setState = async (fact: Fact, next: 'accepted' | 'rejected', ): Promise<void> => {
    setMenuFor(undefined);
    await store.actions.saveFacts([
      {
        factId: fact.id,
        ...(fact.characterId === undefined ? {} : { characterId: fact.characterId }),
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        text: fact.text,
        sourceMessageIds: fact.sourceMessageIds,
        ...(fact.confidence === undefined ? {} : { confidence: fact.confidence }),
        state: next,
        createdBy: 'user',
      },
    ]);
    await reload();
  };

  /** 一键导出世界书：只导已采纳的，provenance 跟着进条目注释。 */
  const exportToLore = async (): Promise<void> => {
    setError(undefined);
    setNote(undefined);
    const book = state.lorebooks[0];
    if (book === undefined) {
      setError(t('facts.noBook'));
      return;
    }
    const entries = factsToLoreEntries(facts);
    if (entries.length === 0) {
      setNote(t('facts.nothingAccepted'));
      return;
    }
    for (const entry of entries) {
      await store.actions.saveLoreEntry({ ...entry, lorebookId: book.id });
    }
    setNote(t('facts.exported', { count: entries.length, book: book.name }));
  };

  /** 每条事实的核对结果（派生计算，见 verifyProvenance）。 */
  const checkOf = (fact: Fact): ProvenanceCheck => verifyProvenance(fact, messages);

  const label = (fact: Fact): string =>
    fact.state === 'accepted' ? t('facts.state.accepted') : fact.state === 'rejected' ? t('facts.state.rejected') : t('facts.state.proposed');

  return (
    <>
      <p className="muted">{t('facts.hint')}</p>
      <div className="row">
        <Button disabled={busy || !chat.available} onClick={() => void extract()}>
          {busy ? t('facts.extracting') : t('facts.extract')}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void exportToLore()}>
          {t('facts.export')}
        </Button>
      </div>
      {note !== undefined && <p className="muted">{note}</p>}
      {error !== undefined && <Banner tone="error">{error}</Banner>}
      {conflicts.length > 0 && (
        <Banner tone="warn">
          {t('facts.conflicts', { count: conflicts.length })}：{conflicts[0]?.reason}
        </Banner>
      )}

      {facts.length === 0 ? (
        <EmptyState icon="book" title={t('facts.empty.title')} hint={t('facts.empty.hint')} />
      ) : (
        <ul className="list">
          {facts.map((fact) => (
            <ListRow
              key={fact.id}
              title={fact.text}
              subtitle={`${fact.subject} ｜ ${fact.predicate} ｜ ${fact.object}`}
              meta={[
                label(fact),
                t('facts.sources', { count: fact.sourceMessageIds.length }),
                checkOf(fact).verified ? t('facts.verified') : t('facts.unverified'),
                conflictIds.has(fact.id) ? t('facts.conflictTag') : '',
                fact.confidence === undefined ? '' : `${fact.confidence}`,
              ]
                .filter((part) => part !== '')
                .join(' · ')}
              onClick={() => setMenuFor(fact.id)}
            />
          ))}
        </ul>
      )}

      <Sheet open={menu !== undefined} title={menu?.subject} onClose={() => setMenuFor(undefined)}>
        {menu !== undefined && <p className="muted">{menu.text}</p>}
        {menu !== undefined && <p className="muted">{t('facts.provenance')}：{menu.sourceMessageIds.join('、')}</p>}
        {menu !== undefined && (
          <p className="muted">
            {checkOf(menu).verified ? t('facts.verified') : t('facts.unverified')} —— {checkOf(menu).reason}
          </p>
        )}
        <SheetItem
          icon="edit"
          label={t('facts.accept')}
          onClick={() => {
            const fact = menu;
            if (fact !== undefined) void setState(fact, 'accepted');
          }}
        />
        <SheetItem
          icon="trash"
          label={t('facts.reject')}
          danger
          onClick={() => {
            const fact = menu;
            if (fact !== undefined) void setState(fact, 'rejected');
          }}
        />
      </Sheet>

      {character !== undefined && <p className="muted">{t('facts.forCharacter', { name: character.name })}</p>}
    </>
  );
}
