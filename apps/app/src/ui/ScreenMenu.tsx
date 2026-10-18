import { useState, type ReactNode } from 'react';
import type { Route } from '../app/router.ts';
import type { AppStore } from '../app/state.ts';
import { useT } from '../i18n/context.tsx';
import { useAppState } from '../screens/screen-props.ts';
import { Button, ConfirmDialog, IconButton, Sheet, SheetItem } from './components.tsx';

/**
 * 顶栏右侧的「⋯」菜单：内容按当前页面决定。
 *
 * 放在外壳而不是各页面里，是因为顶栏按钮属于外壳；页面只负责内容与底部操作。
 */
export function ScreenMenu({
  route,
  store,
  onDeleted,
  onNavigate,
}: {
  route: Route;
  store: AppStore;
  onDeleted: () => void;
  onNavigate?: (route: Route) => void;
}): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [forking, setForking] = useState(false);
  const [forkError, setForkError] = useState<string | undefined>(undefined);

  if (route.name !== 'chat') return null;
  const session = state.sessions.find((item) => item.id === route.sessionId);
  if (session === undefined) return null;

  return (
    <>
      <IconButton
        icon="more"
        label={t('sessions.actionMenu')}
        onClick={() => {
          setForkError(undefined);
          setOpen(true);
        }}
      />

      <Sheet open={open} title={session.title} onClose={() => setOpen(false)}>
        <SheetItem
          icon="book"
          label={t('memory.menu')}
          onClick={() => {
            setOpen(false);
            onNavigate?.({ name: 'memories', characterId: session.characterId });
          }}
        />
        <SheetItem
          icon="book"
          label={t('facts.menu')}
          onClick={() => {
            setOpen(false);
            onNavigate?.({ name: 'facts', characterId: session.characterId });
          }}
        />
        <SheetItem
          icon="plus"
          label={forking ? t('sessions.fork.running') : t('sessions.fork.action')}
          disabled={forking}
          onClick={() => {
            setForking(true);
            setForkError(undefined);
            void store.actions
              .forkSession(session.id, { title: t('sessions.fork.title', { title: session.title }) })
              .then((created) => {
                setForking(false);
                setOpen(false);
                onNavigate?.({ name: 'chat', sessionId: created.id });
              })
              .catch((cause: unknown) => {
                setForking(false);
                setForkError(cause instanceof Error ? cause.message : String(cause));
              });
          }}
        />
        <SheetItem
          icon="edit"
          label={t('sessions.rename.action')}
          onClick={() => {
            setRenaming(session.title);
            setOpen(false);
          }}
        />
        <SheetItem
          icon="trash"
          label={t('sessions.delete')}
          danger
          onClick={() => {
            setConfirmDelete(true);
            setOpen(false);
          }}
        />
        {forkError !== undefined && (
          <p className="notice notice--warn">{t('sessions.fork.failed', { message: forkError })}</p>
        )}
      </Sheet>

      <Sheet open={renaming !== ''} title={t('sessions.rename')} onClose={() => setRenaming('')}>
        <div className="sheet__form">
          <input className="input" value={renaming} autoFocus onChange={(event) => setRenaming(event.target.value)} />
          <Button
            block
            disabled={renaming.trim() === ''}
            onClick={() => {
              const title = renaming.trim();
              setRenaming('');
              void store.actions.renameSession(session.id, title);
            }}
          >
            {t('common.confirm')}
          </Button>
        </div>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title={t('sessions.delete')}
        message={t('sessions.delete.message', { title: session.title, count: session.messageCount })}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void store.actions.deleteSession(session.id).then(onDeleted);
        }}
      />
    </>
  );
}
