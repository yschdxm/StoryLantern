import { useState, type ReactNode } from 'react';
import type { Route } from '../app/router.ts';
import type { AppStore } from '../app/state.ts';
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
}: {
  route: Route;
  store: AppStore;
  onDeleted: () => void;
}): ReactNode {
  const state = useAppState(store);
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (route.name !== 'chat') return null;
  const session = state.sessions.find((item) => item.id === route.sessionId);
  if (session === undefined) return null;

  return (
    <>
      <IconButton icon="more" label="会话操作" onClick={() => setOpen(true)} />

      <Sheet open={open} title={session.title} onClose={() => setOpen(false)}>
        <SheetItem
          icon="edit"
          label="重命名会话"
          onClick={() => {
            setRenaming(session.title);
            setOpen(false);
          }}
        />
        <SheetItem
          icon="trash"
          label="删除会话"
          danger
          onClick={() => {
            setConfirmDelete(true);
            setOpen(false);
          }}
        />
      </Sheet>

      <Sheet open={renaming !== ''} title="重命名会话" onClose={() => setRenaming('')}>
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
            确定
          </Button>
        </div>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        title="删除会话"
        message={`「${session.title}」及其 ${session.messageCount} 条消息将被删除，无法恢复。`}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void store.actions.deleteSession(session.id).then(onDeleted);
        }}
      />
    </>
  );
}
