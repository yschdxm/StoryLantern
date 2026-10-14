import { useEffect, useState, type ReactNode } from 'react';
import { useAppState, type ScreenProps } from './screen-props.ts';
import { formatTime, previewOf } from '../data/repository.ts';
import {
  Banner,
  Button,
  ConfirmDialog,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  LoadingState,
  Sheet,
  SheetItem,
} from '../ui/components.tsx';

/**
 * 会话列表（首页）。
 *
 * 人机工学要点：每行 64px 高、整行可点、右侧「⋯」是独立 44px 触控目标；
 * 空态给一句明确的下一步，而不是空白页。
 */
export function SessionsScreen({ store, router }: ScreenProps): ReactNode {
  const state = useAppState(store);
  const [menuFor, setMenuFor] = useState<number | undefined>(undefined);
  const [pickCharacter, setPickCharacter] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; title: string } | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<number | undefined>(undefined);

  const menu = state.sessions.find((session) => session.id === menuFor);
  const deleting = state.sessions.find((session) => session.id === confirmDelete);

  const startNew = (): void => {
    if (state.characters.length === 0) {
      router.navigate({ name: 'character', characterId: 'new' });
      return;
    }
    setPickCharacter(true);
  };

  if (state.status === 'loading' && state.sessions.length === 0) return <LoadingState label="正在读取会话…" />;

  return (
    <>
      {state.error !== undefined && (
        <Banner tone="error" action={<Button variant="ghost" onClick={() => void store.actions.refresh()}>重试</Button>}>
          {state.error}
        </Banner>
      )}

      {state.sessions.length === 0 ? (
        <EmptyState
          icon="chat"
          title="还没有会话"
          hint={state.characters.length === 0 ? '先创建一个角色，然后就能和它聊天了' : '选一个角色开始新的会话'}
          action={<Button onClick={startNew}>{state.characters.length === 0 ? '创建角色' : '新建会话'}</Button>}
        />
      ) : (
        <ul className="list">
          {state.sessions.map((session) => (
            <ListRow
              key={session.id}
              title={session.title}
              subtitle={previewOf(session.lastMessage)}
              meta={formatTime(session.updatedAt)}
              onClick={() => router.navigate({ name: 'chat', sessionId: session.id })}
              trailing={
                <IconButton icon="more" label="更多操作" onClick={() => setMenuFor(session.id)} />
              }
            />
          ))}
        </ul>
      )}

      <button type="button" className="fab" aria-label="新建会话" onClick={startNew}>
        <Icon name="plus" size={26} />
      </button>

      <Sheet open={pickCharacter} title="选择角色" onClose={() => setPickCharacter(false)}>
        {state.characters.map((character) => (
          <SheetItem
            key={character.id}
            icon="user"
            label={character.name}
            onClick={() => {
              setPickCharacter(false);
              void store.actions.createSession(character.id).then((session) => {
                router.navigate({ name: 'chat', sessionId: session.id });
              });
            }}
          />
        ))}
      </Sheet>

      <Sheet open={menu !== undefined} title={menu?.title} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="edit"
          label="重命名"
          onClick={() => {
            if (menu !== undefined) setRenaming({ id: menu.id, title: menu.title });
            setMenuFor(undefined);
          }}
        />
        <SheetItem
          icon="trash"
          label="删除会话"
          danger
          onClick={() => {
            setConfirmDelete(menuFor);
            setMenuFor(undefined);
          }}
        />
      </Sheet>

      <RenameSheet
        value={renaming}
        onClose={() => setRenaming(undefined)}
        onSubmit={(id, title) => {
          setRenaming(undefined);
          void store.actions.renameSession(id, title);
        }}
      />

      <ConfirmDialog
        open={deleting !== undefined}
        title="删除会话"
        message={`「${deleting?.title ?? ''}」及其 ${deleting?.messageCount ?? 0} 条消息将被删除，无法恢复。`}
        onCancel={() => setConfirmDelete(undefined)}
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(undefined);
          if (id !== undefined) void store.actions.deleteSession(id);
        }}
      />
    </>
  );
}

/** 重命名：小输入框 + 确定，避免再引一个页面。 */
function RenameSheet({
  value,
  onClose,
  onSubmit,
}: {
  value: { id: number; title: string } | undefined;
  onClose: () => void;
  onSubmit: (id: number, title: string) => void;
}): ReactNode {
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (value !== undefined) setDraft(value.title);
  }, [value]);

  return (
    <Sheet open={value !== undefined} title="重命名会话" onClose={onClose}>
      <div className="sheet__form">
        <input
          className="input"
          value={draft}
          autoFocus
          placeholder="会话名"
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          block
          disabled={draft.trim() === ''}
          onClick={() => {
            if (value !== undefined) onSubmit(value.id, draft.trim());
          }}
        >
          确定
        </Button>
      </div>
    </Sheet>
  );
}
