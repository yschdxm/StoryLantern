/**
 * 极简 hash 路由。
 *
 * 为什么不用 react-router：这里只需要"几个页面 + 返回栈"，而 hash 路由在 WebView 里
 * 天然与 Android 的返回手势/返回键一致（history 由浏览器管）。自己写 60 行，换来零依赖与可测。
 */

export type Route =
  | { name: 'sessions' }
  | { name: 'characters' }
  | { name: 'settings' }
  | { name: 'chat'; sessionId: number }
  | { name: 'character'; characterId: number | 'new' };

export const ROOT_ROUTE: Route = { name: 'sessions' };

/** `#/chat/12` → `{ name: 'chat', sessionId: 12 }`；无法识别时回根路由。 */
export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = clean.split('/').filter((part) => part !== '');
  const [head, tail] = parts;

  switch (head) {
    case undefined:
    case '':
      return ROOT_ROUTE;
    case 'characters':
      return { name: 'characters' };
    case 'settings':
      return { name: 'settings' };
    case 'chat': {
      const sessionId = Number(tail);
      return Number.isInteger(sessionId) && sessionId > 0 ? { name: 'chat', sessionId } : ROOT_ROUTE;
    }
    case 'character': {
      if (tail === 'new') return { name: 'character', characterId: 'new' };
      const characterId = Number(tail);
      return Number.isInteger(characterId) && characterId > 0 ? { name: 'character', characterId } : { name: 'characters' };
    }
    default:
      return ROOT_ROUTE;
  }
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'sessions':
      return '#/sessions';
    case 'characters':
      return '#/characters';
    case 'settings':
      return '#/settings';
    case 'chat':
      return `#/chat/${route.sessionId}`;
    case 'character':
      return `#/character/${route.characterId}`;
  }
}

/** 底部标签：只有这三个是"根页面"；聊天与角色编辑是二级页面（带返回）。 */
export const TABS: Array<{ route: Route; label: string; icon: string }> = [
  { route: { name: 'sessions' }, label: '会话', icon: 'chat' },
  { route: { name: 'characters' }, label: '角色', icon: 'user' },
  { route: { name: 'settings' }, label: '设置', icon: 'gear' },
];

export function isRootRoute(route: Route): boolean {
  return route.name === 'sessions' || route.name === 'characters' || route.name === 'settings';
}

/** 当前标签（二级页面归属它的来源标签，保证底栏高亮不闪）。 */
export function activeTabName(route: Route): Route['name'] {
  if (route.name === 'chat') return 'sessions';
  if (route.name === 'character') return 'characters';
  return route.name;
}

export interface Router {
  current(): Route;
  subscribe(listener: (route: Route) => void): () => void;
  navigate(route: Route, options?: { replace?: boolean }): void;
  /** 返回上一级（Android 返回手势由 WebView 的 history 负责，这里给自定义返回按钮用）。 */
  back(): void;
}

/** 页面的上一级：二级页面回到它的来源标签，根页面没有上级。 */
export function parentOf(route: Route): Route | undefined {
  switch (route.name) {
    case 'chat':
      return { name: 'sessions' };
    case 'character':
      return { name: 'characters' };
    default:
      return undefined;
  }
}

interface RouterScope {
  location: { hash: string };
  history: { pushState(data: unknown, title: string, url?: string): void; replaceState(data: unknown, title: string, url?: string): void; back(): void; readonly length: number };
  onHashChange(listener: () => void): () => void;
}

export function createRouter(scope?: Partial<RouterScope>): Router {
  const runtime: RouterScope = {
    location: scope?.location ?? globalThis.location,
    history: scope?.history ?? globalThis.history,
    onHashChange:
      scope?.onHashChange ??
      ((listener: () => void) => {
        globalThis.addEventListener('hashchange', listener);
        return () => globalThis.removeEventListener('hashchange', listener);
      }),
  };

  const listeners = new Set<(route: Route) => void>();

  const emit = (): void => {
    const route = parseRoute(runtime.location.hash);
    for (const listener of listeners) listener(route);
  };

  runtime.onHashChange(emit);

  return {
    current: () => parseRoute(runtime.location.hash),

    subscribe(listener) {
      listeners.add(listener);
      listener(parseRoute(runtime.location.hash));
      return () => listeners.delete(listener);
    },

    navigate(route, options = {}) {
      const hash = routeToHash(route);
      if (runtime.location.hash === hash) return;
      if (options.replace === true) runtime.history.replaceState(null, '', hash);
      else runtime.history.pushState(null, '', hash);
      emit();
    },

    back() {
      // 刻意**不**依赖 history 计数：WebView 里 history.length 不可靠，而"根页面按返回"
      // 应当交给系统（退出应用），"二级页面按返回"应当回它的来源标签。按页面层级走最确定。
      const parent = parentOf(parseRoute(runtime.location.hash));
      if (parent === undefined) return;
      this.navigate(parent, { replace: true });
    },
  };
}
