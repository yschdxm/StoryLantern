import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createTauriBridgeFromGlobal, createTauriTransport } from '../../../packages/wire/src/index.ts';
import type { LocaleService } from '../../../packages/plugin-api/src/index.ts';
import { createAppRuntime, type AppRuntime } from './composition.ts';
import { createAppStore, type AppStore } from './app/state.ts';
import { createRouter, isRootRoute, TABS, type Route } from './app/router.ts';
import { createHostRepository } from './data/host-repository.ts';
import { createChatClient } from './data/chat-client.ts';
import { createBrowserRepository } from './data/local-repository.ts';
import { SETTING_KEYS } from './data/types.ts';
import type { Repository } from './data/repository.ts';
import { createHostClient, type HostClient } from './host-panel.ts';
import { AppShell } from './ui/AppShell.tsx';
import { ScreenMenu } from './ui/ScreenMenu.tsx';
import { SessionsScreen } from './screens/SessionsScreen.tsx';
import { ChatScreen } from './screens/ChatScreen.tsx';
import { CharactersScreen } from './screens/CharactersScreen.tsx';
import { CharacterEditScreen } from './screens/CharacterEditScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import './styles.css';

/**
 * 启动：
 *  1. 选仓储——在 Tauri 里走宿主 SQLite，在浏览器里走 localStorage（同一套行为，契约测试保证）；
 *  2. 组合插件（core bundle），拿到 locale 等服务；失败也不阻断界面（只是没有多语言）；
 *  3. 挂外壳 + 按路由渲染页面。
 */
const bridge = createTauriBridgeFromGlobal();
const transport = bridge === undefined ? undefined : createTauriTransport({ bridge });
const repository: Repository = transport === undefined ? createBrowserRepository() : createHostRepository(transport);
const host: HostClient = createHostClient(bridge);
const chat = createChatClient(transport);
const store: AppStore = createAppStore(repository);
const router = createRouter();

interface Boot {
  runtime?: AppRuntime;
  locale?: LocaleService;
}

const TITLES: Record<Route['name'], string> = {
  sessions: '会话',
  characters: '角色',
  settings: '设置',
  chat: '聊天',
  character: '角色',
};

function Root(): ReturnType<typeof AppShell> {
  const [route, setRoute] = useState<Route>(() => router.current());
  const [boot, setBoot] = useState<Boot>({});
  const [state, setState] = useState(() => store.getState());

  useEffect(() => router.subscribe(setRoute), []);
  useEffect(() => store.subscribe(setState), []);

  useEffect(() => {
    void store.actions.refresh();
    // 插件组合：拿到 locale 与插件清单（界面里的"已激活的插件"就是它）
    void createAppRuntime()
      .then((runtime) => setBoot({ runtime, locale: runtime.locale }))
      .catch(() => setBoot({}));
  }, []);

  // 主题：跟随设置（深色为默认）
  useEffect(() => {
    const theme = state.settings[SETTING_KEYS.theme] ?? 'dark';
    document.documentElement.dataset['theme'] = theme === '' ? 'dark' : theme;
  }, [state.settings]);

  const session = route.name === 'chat' ? state.sessions.find((item) => item.id === route.sessionId) : undefined;
  const title =
    route.name === 'chat'
      ? (session?.title ?? TITLES.chat)
      : route.name === 'character'
        ? route.characterId === 'new'
          ? '新建角色'
          : '编辑角色'
        : TITLES[route.name];

  return (
    <AppShell
      route={route}
      title={title}
      {...(route.name === 'chat' && session !== undefined && session.title !== session.characterName
        ? { subtitle: session.characterName }
        : {})}
      {...(isRootRoute(route) ? {} : { onBack: () => router.back() })}
      actions={<ScreenMenu route={route} store={store} onDeleted={() => router.navigate({ name: 'sessions' })} />}
      onNavigate={(next) => router.navigate(next)}
      layout={route.name === 'chat' ? 'fill' : 'scroll'}
      hideTabs={route.name === 'chat' || route.name === 'character'}
    >
      {route.name === 'sessions' && <SessionsScreen store={store} router={router} host={host} chat={chat} />}
      {route.name === 'characters' && <CharactersScreen store={store} router={router} host={host} chat={chat} />}
      {route.name === 'settings' && (
        <SettingsScreen
          store={store}
          router={router}
          host={host}
          chat={chat}
          plugins={boot.runtime?.tracker.list().map((outcome) => ({ id: outcome.id, status: outcome.status })) ?? []}
          locales={boot.locale?.locales() ?? []}
          onLocaleChange={(next) => {
            boot.locale?.setLocale(next);
            void store.actions.setSetting(SETTING_KEYS.locale, next);
            setBoot((current) => ({ ...current }));
          }}
        />
      )}
      {route.name === 'chat' && (
        <ChatScreen
          store={store}
          router={router}
          host={host}
          chat={chat}
          sessionId={route.sessionId}
          onOpenSettings={() => router.navigate({ name: 'settings' })}
        />
      )}
      {route.name === 'character' && (
        <CharacterEditScreen
          store={store}
          router={router}
          host={host}
          chat={chat}
          characterId={route.characterId}
          onDone={() => router.navigate({ name: 'characters' }, { replace: true })}
        />
      )}
    </AppShell>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('缺少 #root 容器');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

// 让底栏标签常量在编译期有用（AppShell 直接用 TABS，这里避免 tree-shaking 误删类型导出）
export type { TABS };
