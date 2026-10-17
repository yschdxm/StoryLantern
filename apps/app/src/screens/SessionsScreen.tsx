import { useEffect, useState, type ReactNode } from 'react';
import { useAppState, type ScreenProps } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
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
  LoadMore,
  Sheet,
  SheetItem,
  useWindowedList,
} from '../ui/components.tsx';
import { openingGreetings } from '../data/greeting.ts';

/**
 * 会话列表（首页）。
 *
 * 人机工学要点：每行 64px 高、整行可点、右侧「⋯」是独立 44px 触控目标；
 * 支持"向左滑删除"与"长按出菜单"两种不必记住的入口；空态给明确的下一步，不留白屏。
 */
export function SessionsScreen({ store, router }: ScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [pickCharacter, setPickCharacter] = useState(false);
  /** 正在选开场白的角色 id；undefined = 没开这个面板。 */
  const [greetingFor, setGreetingFor] = useState<string | undefined>(undefined);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined);

  const { visible, hidden, sentinel } = useWindowedList(state.sessions, { pageSize: 30 });

  const menu = state.sessions.find((session) => session.id === menuFor);
  const greetingCharacter = state.characters.find((character) => character.id === greetingFor);
  const deleting = state.sessions.find((session) => session.id === confirmDelete);

  /** 建会话并进聊天页；greetingIndex 交给仓储（0=第一条、-1=不插入）。 */
  const startChat = (characterId: string, greetingIndex: number): void => {
    void store.actions.createSession(characterId, undefined, greetingIndex).then((session) => {
      router.navigate({ name: 'chat', sessionId: session.id });
    });
  };

  const startNew = (): void => {
    if (state.characters.length === 0) {
      router.navigate({ name: 'character', characterId: 'new' });
      return;
    }
    setPickCharacter(true);
  };

  if (state.status === 'loading' && state.sessions.length === 0) return <LoadingState label={t('sessions.loading')} />;

  return (
    <>
      {state.error !== undefined && (
        <Banner tone="error" action={<Button variant="ghost" onClick={() => void store.actions.refresh()}>{t('common.retry')}</Button>}>
          {state.error}
        </Banner>
      )}

      {state.sessions.length === 0 ? (
        <EmptyState
          icon="chat"
          title={t('sessions.empty.title')}
          hint={state.characters.length === 0 ? t('sessions.empty.needCharacter') : t('sessions.empty.pickCharacter')}
          action={<Button onClick={startNew}>{state.characters.length === 0 ? t('sessions.createCharacter') : t('sessions.new')}</Button>}
        />
      ) : (
        <ul className="list">
          {visible.map((session) => (
            <ListRow
              key={session.id}
              title={session.title}
              subtitle={previewOf(session.lastMessage)}
              meta={formatTime(session.updatedAt)}
              onClick={() => router.navigate({ name: 'chat', sessionId: session.id })}
              onLongPress={() => setMenuFor(session.id)}
              onSwipeDelete={() => setConfirmDelete(session.id)}
              trailing={<IconButton icon="more" label={t('common.more')} onClick={() => setMenuFor(session.id)} />}
            />
          ))}
        </ul>
      )}
      <LoadMore hidden={hidden} sentinel={sentinel} />
      {state.sessions.length > 0 && (

      <button type="button" className="fab" aria-label={t('sessions.new')} onClick={startNew}>
        <Icon name="plus" size={26} />
      </button>
      )}

      <Sheet open={pickCharacter} title={t('sessions.pick.title')} onClose={() => setPickCharacter(false)}>
        {state.characters.map((character) => (
          <SheetItem
            key={character.id}
            icon="user"
            label={character.name}
            onClick={() => {
              setPickCharacter(false);
              // 有备选开场白就先问用哪一条；只有一条就沿用旧行为（直接用它）
              if (character.alternateGreetings.length > 0) setGreetingFor(character.id);
              else startChat(character.id, 0);
            }}
          />
        ))}
      </Sheet>

      <Sheet
        open={greetingFor !== undefined}
        title={t('sessions.greeting.title')}
        onClose={() => setGreetingFor(undefined)}
      >
        {openingGreetings(greetingCharacter ?? { alternateGreetings: [] }).map((text, index) => (
          <SheetItem
            key={'greeting-' + index}
            icon="chat"
            label={t('sessions.greeting.item', { n: index + 1, text: previewOf(text) })}
            onClick={() => {
              const id = greetingFor;
              setGreetingFor(undefined);
              if (id !== undefined) startChat(id, index);
            }}
          />
        ))}
        <SheetItem
          icon="stop"
          label={t('sessions.greeting.none')}
          onClick={() => {
            const id = greetingFor;
            setGreetingFor(undefined);
            if (id !== undefined) startChat(id, -1);
          }}
        />
      </Sheet>

      <Sheet open={menu !== undefined} title={menu?.title} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="edit"
          label={t('sessions.rename.action')}
          onClick={() => {
            if (menu !== undefined) setRenaming({ id: menu.id, title: menu.title });
            setMenuFor(undefined);
          }}
        />
        <SheetItem
          icon="trash"
          label={t('sessions.delete')}
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
        title={t('sessions.delete')}
        message={t('sessions.delete.message', { title: deleting?.title ?? '', count: deleting?.messageCount ?? 0 })}
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
  value: { id: string; title: string } | undefined;
  onClose: () => void;
  onSubmit: (id: string, title: string) => void;
}): ReactNode {
  const t = useT();
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (value !== undefined) setDraft(value.title);
  }, [value]);

  return (
    <Sheet open={value !== undefined} title={t('sessions.rename')} onClose={onClose}>
      <div className="sheet__form">
        <input
          className="input"
          value={draft}
          autoFocus
          placeholder={t('sessions.title.field')}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button
          block
          disabled={draft.trim() === ''}
          onClick={() => {
            if (value !== undefined) onSubmit(value.id, draft.trim());
          }}
        >
          {t('common.confirm')}
        </Button>
      </div>
    </Sheet>
  );
}
