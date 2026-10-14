import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createTauriBridgeFromGlobal, createTauriTransport } from '../../../packages/wire/src/index.ts';
import type { LocaleService } from '../../../packages/plugin-api/src/index.ts';
import { createAppRuntime, type AppRuntime } from './composition.ts';
import { createAppStore, type AppStore } from './app/state.ts';
import { createRouter, isRootRoute, type Route } from './app/router.ts';
import { createHostRepository } from './data/host-repository.ts';
import { createChatClient } from './data/chat-client.ts';
import { createBrowserRepository } from './data/local-repository.ts';
import { SETTING_KEYS } from './data/types.ts';
import type { Repository } from './data/repository.ts';
import { createHostClient, type HostClient } from './host-panel.ts';
import { I18nProvider } from './i18n/context.tsx';
import { createAppLocaleService, registerAppMessages, translatorOf } from './i18n/locale.ts';
import { AppShell } from './ui/AppShell.tsx';
import { ScreenMenu } from './ui/ScreenMenu.tsx';
import { SessionsScreen } from './screens/SessionsScreen.tsx';
import { ChatScreen } from './screens/ChatScreen.tsx';
import { CharactersScreen } from './screens/CharactersScreen.tsx';
import { CharacterEditScreen } from './screens/CharacterEditScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import { ImportScreen } from './screens/ImportScreen.tsx';
import './styles.css';

/**
 * 启动：
 *  1. 选仓储——在 Tauri 里走宿主 SQLite，在浏览器里走 localStorage（同一套行为，契约测试保证）；
 *  2. 组合插件（core bundle），拿到 locale 等服务；失败也**不阻断界面**（用应用自带的目录兜底）；
 *  3. 应用外观设置（主题/字号），挂外壳 + 按路由渲染页面。
 */
const bridge = createTauriBridgeFromGlobal();
const transport = bridge === undefined ? undefined : createTauriTransport({ bridge });
const repository: Repository = transport === undefined ? createBrowserRepository() : createHostRepository(transport);
const host: HostClient = createHostClient(bridge);
const chat = createChatClient(transport);
const store: AppStore = createAppStore(repository);
const router = createRouter();

/** 字号倍率：只缩放文字（正文用 rem），触控目标仍保持 ≥44px。 */
const FONT_SCALES: Record<string, string> = { small: '0.92', normal: '1', large: '1.14' };

interface Boot {
  runtime?: AppRuntime;
  locale: LocaleService;
}

function Root(): ReturnType<typeof AppShell> {
  const [route, setRoute] = useState<Route>(() => router.current());
  const [boot, setBoot] = useState<Boot>(() => ({ locale: createAppLocaleService() }));
  const [state, setState] = useState(() => store.getState());

  useEffect(() => router.subscribe(setRoute), []);
  useEffect(() => store.subscribe(setState), []);

  useEffect(() => {
    void store.actions.refresh();
    // 插件组合：拿到 locale 与插件清单（设置里的"已激活的插件"就是它）
    void createAppRuntime()
      .then((runtime) => {
        registerAppMessages(runtime.locale);
        setBoot({ runtime, locale: runtime.locale });
      })
      .catch(() => setBoot((current) => ({ ...current })));
  }, []);

  // 已保存的语言：设置读回来之后应用一次（只跟"设置里的值"同步，避免来回打架）
  const savedLocale = state.settings[SETTING_KEYS.locale];
  useEffect(() => {
    if (savedLocale === undefined || savedLocale === '' || savedLocale === boot.locale.locale) return;
    if (boot.locale.setLocale(savedLocale)) setBoot((current) => ({ ...current }));
  }, [savedLocale, boot.locale]);

  // 主题与字号：跟随设置，改一处即全应用生效
  useEffect(() => {
    const root = document.documentElement;
    root.dataset['theme'] = state.settings[SETTING_KEYS.theme] ?? 'dark';
    root.style.setProperty('--font-scale', FONT_SCALES[state.settings[SETTING_KEYS.fontScale] ?? 'normal'] ?? '1');
  }, [state.settings]);

  const t = useMemo(() => translatorOf(boot.locale), [boot.locale]);

  const session = route.name === 'chat' ? state.sessions.find((item) => item.id === route.sessionId) : undefined;
  const title =
    route.name === 'chat'
      ? (session?.title ?? t('tab.sessions'))
      : route.name === 'character'
        ? route.characterId === 'new'
          ? t('character.new.title')
          : t('character.edit.title')
        : route.name === 'import'
          ? t('import.title')
          : t(`tab.${route.name}`);

  return (
    <I18nProvider t={t}>
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
        hideTabs={route.name === 'chat' || route.name === 'character' || route.name === 'import'}
      >
        {route.name === 'sessions' && <SessionsScreen store={store} router={router} host={host} chat={chat} />}
        {route.name === 'characters' && <CharactersScreen store={store} router={router} host={host} chat={chat} />}
        {route.name === 'import' && <ImportScreen store={store} router={router} host={host} chat={chat} />}
        {route.name === 'settings' && (
          <SettingsScreen
            store={store}
            router={router}
            host={host}
            chat={chat}
            plugins={boot.runtime?.tracker.list().map((outcome) => ({ id: outcome.id, status: outcome.status })) ?? []}
            locales={boot.locale.locales()}
            onLocaleChange={(next) => {
              boot.locale.setLocale(next);
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
    </I18nProvider>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('缺少 #root 容器');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
