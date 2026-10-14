import { useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { previewOf } from '../data/repository.ts';
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

/** 角色列表。每行显示名字 + 一句话描述；右侧「⋯」提供编辑/删除。 */
export function CharactersScreen({ store, router }: ScreenProps): ReactNode {
  const state = useAppState(store);
  const [menuFor, setMenuFor] = useState<number | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<number | undefined>(undefined);
  const menu = state.characters.find((character) => character.id === menuFor);
  const deleting = state.characters.find((character) => character.id === confirmDelete);

  if (state.status === 'loading' && state.characters.length === 0) return <LoadingState label="正在读取角色…" />;

  return (
    <>
      {state.error !== undefined && (
        <Banner tone="error" action={<Button variant="ghost" onClick={() => void store.actions.refresh()}>重试</Button>}>
          {state.error}
        </Banner>
      )}

      {state.characters.length === 0 ? (
        <EmptyState
          icon="user"
          title="还没有角色"
          hint="填个名字就能开始；描述、性格、开场白可以以后再补"
          action={<Button onClick={() => router.navigate({ name: 'character', characterId: 'new' })}>新建角色</Button>}
        />
      ) : (
        <ul className="list">
          {state.characters.map((character) => (
            <ListRow
              key={character.id}
              title={character.name}
              subtitle={previewOf(character.description || character.personality || '（没有描述）', 40)}
              meta={character.firstMessage === '' ? '无开场白' : '有开场白'}
              onClick={() => router.navigate({ name: 'character', characterId: character.id })}
              trailing={<IconButton icon="more" label="更多操作" onClick={() => setMenuFor(character.id)} />}
            />
          ))}
        </ul>
      )}

      <button
        type="button"
        className="fab"
        aria-label="新建角色"
        onClick={() => router.navigate({ name: 'character', characterId: 'new' })}
      >
        <Icon name="plus" size={26} />
      </button>

      <Sheet open={menu !== undefined} title={menu?.name} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="edit"
          label="编辑"
          onClick={() => {
            const id = menuFor;
            setMenuFor(undefined);
            if (id !== undefined) router.navigate({ name: 'character', characterId: id });
          }}
        />
        <SheetItem
          icon="trash"
          label="删除角色"
          danger
          onClick={() => {
            setConfirmDelete(menuFor);
            setMenuFor(undefined);
          }}
        />
      </Sheet>

      <ConfirmDialog
        open={deleting !== undefined}
        title="删除角色"
        message={`「${deleting?.name ?? ''}」以及它的所有会话和消息都会被删除，无法恢复。`}
        onCancel={() => setConfirmDelete(undefined)}
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(undefined);
          if (id !== undefined) void store.actions.deleteCharacter(id);
        }}
      />
    </>
  );
}
