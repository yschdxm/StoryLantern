import { useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
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
  LoadMore,
  Sheet,
  SheetItem,
  useWindowedList,
} from '../ui/components.tsx';

/** 角色列表。每行显示名字 + 一句话描述；滑动或长按都能删，点击进编辑。 */
export function CharactersScreen({ store, router }: ScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined);

  const { visible, hidden, sentinel } = useWindowedList(state.characters, { pageSize: 30 });

  const menu = state.characters.find((character) => character.id === menuFor);
  const deleting = state.characters.find((character) => character.id === confirmDelete);
  const openNew = (): void => router.navigate({ name: 'character', characterId: 'new' });

  if (state.status === 'loading' && state.characters.length === 0) return <LoadingState label={t('characters.loading')} />;

  return (
    <>
      {state.error !== undefined && (
        <Banner tone="error" action={<Button variant="ghost" onClick={() => void store.actions.refresh()}>{t('common.retry')}</Button>}>
          {state.error}
        </Banner>
      )}

      {state.characters.length === 0 ? (
        <EmptyState
          icon="user"
          title={t('characters.empty.title')}
          hint={t('characters.empty.hint')}
          action={<Button onClick={openNew}>{t('characters.new')}</Button>}
        />
      ) : (
        <ul className="list">
          {visible.map((character) => (
            <ListRow
              key={character.id}
              title={character.name}
              subtitle={previewOf(character.description || character.personality || t('characters.noDescription'), 40)}
              meta={character.firstMessage === '' ? t('characters.noGreeting') : t('characters.hasGreeting')}
              onClick={() => router.navigate({ name: 'character', characterId: character.id })}
              onLongPress={() => setMenuFor(character.id)}
              onSwipeDelete={() => setConfirmDelete(character.id)}
              trailing={<IconButton icon="more" label={t('common.more')} onClick={() => setMenuFor(character.id)} />}
            />
          ))}
        </ul>
      )}
      <LoadMore hidden={hidden} sentinel={sentinel} />

      <button type="button" className="fab" aria-label={t('characters.new')} onClick={openNew}>
        <Icon name="plus" size={26} />
      </button>
      <button type="button" className="fab fab--secondary" aria-label={t('import.title')} onClick={() => router.navigate({ name: 'import' })}>
        <Icon name="import" size={22} />
      </button>

      <Sheet open={menu !== undefined} title={menu?.name} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="edit"
          label={t('characters.edit')}
          onClick={() => {
            const id = menuFor;
            setMenuFor(undefined);
            if (id !== undefined) router.navigate({ name: 'character', characterId: id });
          }}
        />
        <SheetItem
          icon="trash"
          label={t('characters.delete')}
          danger
          onClick={() => {
            setConfirmDelete(menuFor);
            setMenuFor(undefined);
          }}
        />
      </Sheet>

      <ConfirmDialog
        open={deleting !== undefined}
        title={t('characters.delete')}
        message={t('characters.delete.message', { name: deleting?.name ?? '' })}
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
