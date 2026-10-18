import { useEffect, useState, type ReactNode } from 'react';
import type { AppStore } from '../../app/state.ts';
import { describeError } from '../../data/error-text.ts';
import type { Message, MessageFork, MessageRevision } from '../../data/types.ts';
import { useT } from '../../i18n/context.tsx';
import { Button, Sheet } from '../../ui/components.tsx';

const shortId = (id: string): string => (id.length > 10 ? `${id.slice(0, 8)}…` : id);
const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
};

/** 消息版本/分叉（B15/B16）：列出全部 revision、标记当前、点选切回；有 fork 时显示分叉组。 */
export function MessageRevisionsSheet({
  store,
  message,
  onSelect,
  onClose,
}: {
  store: AppStore;
  message: Message | undefined;
  onSelect: (revisionId: string) => Promise<boolean>;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const [revisions, setRevisions] = useState<MessageRevision[]>([]);
  const [forks, setForks] = useState<MessageFork[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [selecting, setSelecting] = useState<string | undefined>(undefined);

  useEffect(() => {
    const id = message?.id;
    if (id === undefined) return;
    let alive = true;
    setLoading(true);
    setError(undefined);
    void Promise.all([store.actions.messageRevisions(id), store.actions.messageForks(id)])
      .then(([nextRevisions, nextForks]) => {
        if (!alive) return;
        setRevisions(nextRevisions);
        setForks(nextForks);
      })
      .catch((cause: unknown) => {
        if (alive) setError(t('chat.revisions.failed', { message: describeError(cause) }));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [message?.id, reload, store, t]);

  const choose = async (revisionId: string): Promise<void> => {
    setSelecting(revisionId);
    setError(undefined);
    try {
      if (await onSelect(revisionId)) onClose();
      else setError(t('chat.revisions.selectFailed', { message: '—' }));
    } catch (cause) {
      setError(t('chat.revisions.selectFailed', { message: describeError(cause) }));
    } finally {
      setSelecting(undefined);
    }
  };

  return (
    <Sheet open={message !== undefined} title={t('chat.revisions.title')} onClose={onClose}>
      {loading && <p className="muted">{t('chat.revisions.loading')}</p>}
      {error !== undefined && (
        <div className="notice notice--warn">
          {error}{' '}
          <Button variant="ghost" onClick={() => setReload((value) => value + 1)}>
            {t('chat.revisions.retry')}
          </Button>
        </div>
      )}
      {!loading && revisions.length === 0 && error === undefined && <p className="muted">{t('chat.revisions.none')}</p>}
      <ul className="trace__list">
        {revisions.map((revision) => (
          <li key={revision.id}>
            <button
              type="button"
              className="list-row"
              disabled={revision.active || selecting !== undefined}
              aria-label={t('chat.revisions.select', { id: shortId(revision.id) })}
              onClick={() => void choose(revision.id)}
            >
              <span className="trace__name">
                {revision.active ? '●' : '○'} {shortId(revision.id)}
                {revision.active ? ` · ${t('chat.revisions.active')}` : ''}
              </span>
              <span className="trace__meta">{preview(revision.content)}</span>
            </button>
          </li>
        ))}
      </ul>
      {forks.length > 0 && (
        <>
          <h3 className="trace__heading">{t('chat.revisions.forks')}</h3>
          <ul className="trace__list">
            {forks.map((fork, index) => (
              <li key={`${fork.baseRevisionId ?? 'root'}-${String(index)}`}>
                <span className="trace__name">
                  {t('chat.revisions.forkLine', {
                    base: fork.baseRevisionId === null ? '—' : shortId(fork.baseRevisionId),
                    ids: fork.revisionIds.map(shortId).join('、'),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Sheet>
  );
}
