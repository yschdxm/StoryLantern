import { useState, type ReactNode } from 'react';
import { describeError } from '../data/error-text.ts';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import { previewOf } from '../data/repository.ts';
import type { LoreEntry } from '../data/types.ts';
import { Button, ConfirmDialog, EmptyState, Field, ListRow, Sheet, SheetItem, TextInput } from '../ui/components.tsx';

export interface LorebookScreenProps extends ScreenProps {
  /** 要看哪一本（来自路由 `#/lorebook/<id>`）。 */
  lorebookId: string;
}

/**
 * 世界书详情：书级信息 + 条目列表。
 *
 * 条目表单刻意把 SillyTavern 那一套字段都摆出来（关键词/次级关键词/优先级/常量/递归/深度），
 * 因为它们直接决定"什么时候注入"——藏起来反而让人猜不透模型为什么看到了某段设定。
 */
export function LorebookScreen({ store, router, lorebookId }: LorebookScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const book = state.lorebooks.find((item) => item.id === lorebookId);

  const [editing, setEditing] = useState<LoreEntry | 'new' | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [confirmEntry, setConfirmEntry] = useState<string | undefined>(undefined);
  const [confirmBook, setConfirmBook] = useState(false);
  const [draft, setDraft] = useState({ name: '', description: '' });

  if (book === undefined) {
    return (
      <EmptyState
        icon="book"
        title={t('lore.missing.title')}
        hint={t('lore.missing.hint')}
        action={<Button onClick={() => router.navigate({ name: 'lore' })}>{t('lore.back')}</Button>}
      />
    );
  }

  const menuEntry = book.entries.find((entry) => entry.id === menuFor);

  const saveBook = async (patch: { name?: string; description?: string; enabled?: boolean; characterIds?: string[] }): Promise<void> => {
    await store.actions.saveLorebook({
      id: book.id,
      name: patch.name ?? book.name,
      description: patch.description ?? book.description,
      characterIds: patch.characterIds ?? book.characterIds,
      enabled: patch.enabled ?? book.enabled,
    });
  };

  const toggleBinding = (characterId: string): void => {
    const next = book.characterIds.includes(characterId)
      ? book.characterIds.filter((id) => id !== characterId)
      : [...book.characterIds, characterId];
    void saveBook({ characterIds: next });
  };

  return (
    <div className="settings">
      <section className="settings-group">
        <h2 className="settings-group__title">{t('lore.book.title')}</h2>
        <Field label={t('lore.name')}>
          <TextInput
            value={draft.name === '' ? book.name : draft.name}
            onChange={(next) => setDraft((current) => ({ ...current, name: next }))}
            onBlur={() => {
              const name = draft.name.trim();
              setDraft((current) => ({ ...current, name: '' }));
              if (name !== '' && name !== book.name) void saveBook({ name });
            }}
          />
        </Field>
        <Field label={t('lore.description')}>
          <TextInput
            value={draft.description === '' ? book.description : draft.description}
            onChange={(next) => setDraft((current) => ({ ...current, description: next }))}
            onBlur={() => {
              const description = draft.description;
              setDraft((current) => ({ ...current, description: '' }));
              if (description !== book.description) void saveBook({ description });
            }}
          />
        </Field>
        <Field label={t('lore.enabled')} hint={t('lore.enabled.hint')}>
          <div className="segmented" role="group">
            <button
              type="button"
              className={`segmented__item${book.enabled ? ' segmented__item--active' : ''}`}
              aria-pressed={book.enabled}
              onClick={() => void saveBook({ enabled: true })}
            >
              {t('lore.on')}
            </button>
            <button
              type="button"
              className={`segmented__item${book.enabled ? '' : ' segmented__item--active'}`}
              aria-pressed={!book.enabled}
              onClick={() => void saveBook({ enabled: false })}
            >
              {t('lore.off')}
            </button>
          </div>
        </Field>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">{t('lore.bindings')}</h2>
        <p className="muted">{t('lore.bindings.hint')}</p>
        <div className="chips">
          <button
            type="button"
            className={`chip${book.characterIds.length === 0 ? ' chip--on' : ''}`}
            onClick={() => void saveBook({ characterIds: [] })}
          >
            {t('lore.scope.global')}
          </button>
          {state.characters.map((character) => (
            <button
              key={character.id}
              type="button"
              className={`chip${book.characterIds.includes(character.id) ? ' chip--on' : ''}`}
              onClick={() => toggleBinding(character.id)}
            >
              {character.name}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">{t('lore.entries', { count: book.entries.length })}</h2>
        {book.entries.length === 0 ? (
          <p className="muted">{t('lore.entries.empty')}</p>
        ) : (
          <ul className="list">
            {book.entries.map((entry) => (
              <ListRow
                key={entry.id}
                title={entry.keys.length === 0 ? t('lore.entry.constantOnly') : entry.keys.join('、')}
                subtitle={previewOf(entry.content, 46)}
                meta={entry.enabled ? `#${entry.order}` : t('lore.entry.disabled')}
                onClick={() => setEditing(entry)}
                onLongPress={() => setMenuFor(entry.id)}
              />
            ))}
          </ul>
        )}
        <div className="row">
          <Button onClick={() => setEditing('new')}>{t('lore.entry.new')}</Button>
          <Button variant="ghost" onClick={() => setConfirmBook(true)}>
            {t('lore.delete.book')}
          </Button>
        </div>
      </section>

      <Sheet
        open={editing !== undefined}
        title={editing === 'new' ? t('lore.entry.new') : t('lore.entry.edit')}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <EntryForm
            entry={editing === 'new' ? undefined : editing}
            onCancel={() => setEditing(undefined)}
            onSubmit={async (draftEntry) => {
              await store.actions.saveLoreEntry({ ...draftEntry, lorebookId: book.id, ...(editing === 'new' ? {} : { id: editing.id }) });
              setEditing(undefined);
            }}
          />
        )}
      </Sheet>

      <Sheet open={menuEntry !== undefined} title={menuEntry?.keys.join('、')} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="edit"
          label={t('lore.entry.edit')}
          onClick={() => {
            const entry = menuEntry;
            setMenuFor(undefined);
            if (entry !== undefined) setEditing(entry);
          }}
        />
        <SheetItem
          icon="trash"
          label={t('common.delete')}
          danger
          onClick={() => {
            const id = menuEntry?.id;
            setMenuFor(undefined);
            setConfirmEntry(id);
          }}
        />
      </Sheet>

      <ConfirmDialog
        open={confirmEntry !== undefined}
        title={t('lore.entry.delete.title')}
        message={t('lore.entry.delete.message')}
        confirmLabel={t('common.delete')}
        onCancel={() => setConfirmEntry(undefined)}
        onConfirm={() => {
          const id = confirmEntry;
          setConfirmEntry(undefined);
          if (id !== undefined) void store.actions.removeLoreEntry(book.id, id);
        }}
      />

      <ConfirmDialog
        open={confirmBook}
        title={t('lore.delete.title')}
        message={t('lore.delete.message', { name: book.name })}
        confirmLabel={t('common.delete')}
        onCancel={() => setConfirmBook(false)}
        onConfirm={() => {
          setConfirmBook(false);
          void store.actions.deleteLorebook(book.id).then(() => router.navigate({ name: 'lore' }));
        }}
      />
    </div>
  );
}

interface EntryDraft {
  keys: string[];
  secondaryKeys: string[];
  content: string;
  order: number;
  enabled: boolean;
  constant: boolean;
  caseSensitive: boolean;
  recursive: boolean;
  depth: number;
}

function EntryForm({
  entry,
  onSubmit,
  onCancel,
}: {
  entry?: LoreEntry | undefined;
  onSubmit: (draft: EntryDraft) => Promise<void>;
  onCancel: () => void;
}): ReactNode {
  const t = useT();
  const [keys, setKeys] = useState(entry?.keys.join('，') ?? '');
  const [secondary, setSecondary] = useState(entry?.secondaryKeys.join('，') ?? '');
  const [content, setContent] = useState(entry?.content ?? '');
  const [order, setOrder] = useState(String(entry?.order ?? 100));
  const [depth, setDepth] = useState(String(entry?.depth ?? 0));
  const [constant, setConstant] = useState(entry?.constant ?? false);
  const [caseSensitive, setCaseSensitive] = useState(entry?.caseSensitive ?? false);
  const [recursive, setRecursive] = useState(entry?.recursive ?? true);
  const [error, setError] = useState<string | undefined>(undefined);

  const split = (text: string): string[] => text.split(/[，,、\n]/).map((part) => part.trim()).filter((part) => part !== '');

  return (
    <div className="sheet__form">
      <Field label={t('lore.entry.keys')} hint={t('lore.entry.keys.hint')}>
        <TextInput value={keys} onChange={setKeys} placeholder="铜铃，隘口" />
      </Field>
      <Field label={t('lore.entry.secondary')} hint={t('lore.entry.secondary.hint')}>
        <TextInput value={secondary} onChange={setSecondary} />
      </Field>
      <Field label={t('lore.entry.content')}>
        <textarea className="input" rows={4} value={content} onChange={(event) => setContent(event.target.value)} />
      </Field>
      <Field label={t('lore.entry.order')} hint={t('lore.entry.order.hint')}>
        <TextInput type="number" value={order} onChange={setOrder} />
      </Field>
      <Field label={t('lore.entry.depth')} hint={t('lore.entry.depth.hint')}>
        <TextInput type="number" value={depth} onChange={setDepth} />
      </Field>
      <label className="switch">
        <input type="checkbox" checked={constant} onChange={(event) => setConstant(event.target.checked)} />
        <span>{t('lore.entry.constant')}</span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />
        <span>{t('lore.entry.caseSensitive')}</span>
      </label>
      <label className="switch">
        <input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />
        <span>{t('lore.entry.recursive')}</span>
      </label>
      {error !== undefined && <p className="notice notice--warn">{error}</p>}
      <div className="row">
        <Button
          onClick={() => {
            void onSubmit({
              keys: split(keys),
              secondaryKeys: split(secondary),
              content: content.trim(),
              order: Number.parseInt(order, 10) || 100,
              enabled: entry?.enabled ?? true,
              constant,
              caseSensitive,
              recursive,
              depth: Number.parseInt(depth, 10) || 0,
            }).catch((cause: unknown) => setError(describeError(cause)));
          }}
        >
          {t('common.save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
