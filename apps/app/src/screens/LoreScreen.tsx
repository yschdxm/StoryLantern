import { useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import { previewOf } from '../data/repository.ts';
import { Banner, Button, ConfirmDialog, EmptyState, Icon, ListRow, LoadingState, Sheet, SheetItem } from '../ui/components.tsx';

/**
 * 世界书列表。
 *
 * 这一页解决的是"设定从哪来、哪些角色在用"：一本书要么全局共用，要么绑定到具体角色。
 * 真正的编辑在详情页（条目多、字段多，塞进列表会看不清）。
 */
export function LoreScreen({ store, router }: ScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');

  const menu = state.lorebooks.find((book) => book.id === menuFor);
  const deleting = state.lorebooks.find((book) => book.id === confirmDelete);

  const scopeOf = (characterIds: string[]): string => {
    if (characterIds.length === 0) return t('lore.scope.global');
    const names = characterIds
      .map((id) => state.characters.find((character) => character.id === id)?.name ?? '')
      .filter((name) => name !== '');
    return names.length === 0 ? t('lore.scope.missing') : t('lore.scope.bound', { names: names.join('、') });
  };

  const create = async (): Promise<void> => {
    const name = draftName.trim();
    if (name === '') return;
    const book = await store.actions.saveLorebook({ name });
    setCreating(false);
    setDraftName('');
    router.navigate({ name: 'lorebook', lorebookId: book.id });
  };

  if (state.status === 'loading' && state.lorebooks.length === 0) return <LoadingState label={t('lore.loading')} />;

  return (
    <>
      {state.error !== undefined && (
        <Banner tone="error" action={<Button variant="ghost" onClick={() => void store.actions.refresh()}>{t('common.retry')}</Button>}>
          {state.error}
        </Banner>
      )}

      {state.lorebooks.length === 0 ? (
        <EmptyState
          icon="book"
          title={t('lore.empty.title')}
          hint={t('lore.empty.hint')}
          action={<Button onClick={() => setCreating(true)}>{t('lore.new')}</Button>}
        />
      ) : (
        <>
          <ul className="list">
            {state.lorebooks.map((book) => (
              <ListRow
                key={book.id}
                title={book.name}
                subtitle={previewOf(book.description || scopeOf(book.characterIds), 42)}
                meta={t('lore.entryCount', { count: book.entries.length, state: book.enabled ? t('lore.on') : t('lore.off') })}
                onClick={() => router.navigate({ name: 'lorebook', lorebookId: book.id })}
                onLongPress={() => setMenuFor(book.id)}
              />
            ))}
          </ul>
      {state.lorebooks.length > 0 && (
          <button type="button" className="fab" aria-label={t('lore.new')} onClick={() => setCreating(true)}>
            <Icon name="plus" />
          </button>
      )}
        </>
      )}

      <Sheet open={menu !== undefined} title={menu?.name} onClose={() => setMenuFor(undefined)}>
        <SheetItem icon="edit" label={t('lore.open')} onClick={() => {
          const id = menu?.id;
          setMenuFor(undefined);
          if (id !== undefined) router.navigate({ name: 'lorebook', lorebookId: id });
        }} />
        <SheetItem icon="trash" label={t('common.delete')} danger onClick={() => {
          const id = menu?.id;
          setMenuFor(undefined);
          setConfirmDelete(id);
        }} />
      </Sheet>

      <ConfirmDialog
        open={deleting !== undefined}
        title={t('lore.delete.title')}
        message={t('lore.delete.message', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onCancel={() => setConfirmDelete(undefined)}
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(undefined);
          if (id !== undefined) void store.actions.deleteLorebook(id);
        }}
      />

      <Sheet open={creating} title={t('lore.new')} onClose={() => setCreating(false)}>
        <div className="sheet__form">
          <input
            className="input"
            value={draftName}
            placeholder={t('lore.name.placeholder')}
            autoFocus
            onChange={(event) => setDraftName(event.target.value)}
          />
          <Button onClick={() => void create()}>{t('common.save')}</Button>
        </div>
      </Sheet>
    </>
  );
}
