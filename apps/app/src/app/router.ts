/**
 * 极简 hash 路由。
 *
 * 为什么不用 react-router：这里只需要"几个页面 + 返回栈"，而 hash 路由在 WebView 里
 * 天然与 Android 的返回手势/返回键一致（history 由浏览器管）。自己写 60 行，换来零依赖与可测。
 */

/**
 * 设置页的分区（L2）。L1 是 `{ name: 'settings' }`（设置首页），
 * 每个分区再往下一层是各分区自己的详情/编辑页（L3，页内状态，不改 hash）。
 */
export type SettingsSection = 'model' | 'appearance' | 'sync' | 'data' | 'advanced' | 'about';

export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['model', 'appearance', 'sync', 'data', 'advanced', 'about'];

export function isSettingsSection(value: string | undefined): value is SettingsSection {
  return value !== undefined && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

export type Route =
  | { name: 'sessions' }
  | { name: 'characters' }
  | { name: 'lore' }
  | { name: 'world'; kind?: WorldKind }
  | { name: 'worldCard'; kind: WorldKind; cardId: string | 'new' }
  | { name: 'settings'; section?: SettingsSection }
  | { name: 'import' }
  | { name: 'chat'; sessionId: string }
  | { name: 'character'; characterId: string | 'new' }
  | { name: 'lorebook'; lorebookId: string }
  | { name: 'memories'; characterId: string }
  | { name: 'facts'; characterId: string };

/** 世界资源的三类卡片（世界包不是卡片，单独在列表里展示，不给编辑器）。 */
export type WorldKind = 'scene' | 'item' | 'lore';

export const WORLD_KINDS: readonly WorldKind[] = ['scene', 'item', 'lore'];

export function isWorldKind(value: string | undefined): value is WorldKind {
  return value !== undefined && (WORLD_KINDS as readonly string[]).includes(value);
}

export const ROOT_ROUTE: Route = { name: 'sessions' };

/**
 * 路径段解码。
 *
 * 为什么必须解码：实体 id 不保证是 ASCII（例如从事实导出的典籍 id 是
 * `fact-fact-铜铃-…`）。`history.pushState` 之后 `location.hash` 返回的是**百分号编码**后的形式，
 * 不解码就会拿 `%E9%93%9C…` 去查卡片 → 查不到（真机上踩过："找不到这张卡片"）。
 */
function decodePart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** 路径段编码：id 里可能出现中文/空格/保留字符，必须编码后再进 hash。 */
function encodePart(part: string): string {
  return encodeURIComponent(part);
}

/** `#/chat/12` → `{ name: 'chat', sessionId: 12 }`；无法识别时回根路由。 */
export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const parts = clean.split('/').filter((part) => part !== '').map(decodePart);
  const [head, tail] = parts;

  switch (head) {
    case undefined:
    case '':
      return ROOT_ROUTE;
    case 'characters':
      return { name: 'characters' };
    case 'lore':
      return { name: 'lore' };
    case 'world':
      return isWorldKind(tail) ? { name: 'world', kind: tail } : { name: 'world' };
    case 'worldcard': {
      const [, kind, cardId] = parts;
      if (!isWorldKind(kind) || cardId === undefined || cardId === '') return { name: 'world' };
      return { name: 'worldCard', kind, cardId };
    }
    case 'lorebook':
      return tail === undefined || tail === '' ? { name: 'lore' } : { name: 'lorebook', lorebookId: tail };
    case 'memories':
      return tail === undefined || tail === '' ? { name: 'characters' } : { name: 'memories', characterId: tail };
    case 'settings':
      // `#/settings/sync` → 同步分区；未知分区回设置首页（而不是掉到会话页）
      return isSettingsSection(tail) ? { name: 'settings', section: tail } : { name: 'settings' };
    case 'import':
      return { name: 'import' };
    case 'chat': {
      // 会话 id 是 ULID 字符串（跨设备唯一），因此只校验"非空"
      return tail === undefined || tail === '' ? ROOT_ROUTE : { name: 'chat', sessionId: tail };
    }
    case 'character': {
      if (tail === undefined || tail === '') return { name: 'characters' };
      return { name: 'character', characterId: tail };
    }
    case 'facts': {
      if (tail === undefined || tail === '') return ROOT_ROUTE;
      return { name: 'facts', characterId: tail };
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
    case 'lore':
      return '#/lore';
    case 'world':
      return route.kind === undefined ? '#/world' : `#/world/${route.kind}`;
    case 'worldCard':
      return `#/worldcard/${route.kind}/${encodePart(route.cardId)}`;
    case 'lorebook':
      return `#/lorebook/${encodePart(route.lorebookId)}`;
    case 'memories':
      return `#/memories/${encodePart(route.characterId)}`;
    case 'facts':
      return `#/facts/${encodePart(route.characterId)}`;
    case 'settings':
      return route.section === undefined ? '#/settings' : `#/settings/${route.section}`;
    case 'import':
      return '#/import';
    case 'chat':
      return `#/chat/${encodePart(route.sessionId)}`;
    case 'character':
      return `#/character/${encodePart(route.characterId)}`;
  }
}

/** 底部标签：这四个是"根页面"；聊天、角色编辑、世界书详情是二级页面（带返回）。 */
export const TABS: Array<{ route: Route; label: string; icon: string }> = [
  { route: { name: 'sessions' }, label: 'tab.sessions', icon: 'chat' },
  { route: { name: 'characters' }, label: 'tab.characters', icon: 'user' },
  { route: { name: 'world' }, label: 'tab.lore', icon: 'book' },
  { route: { name: 'settings' }, label: 'tab.settings', icon: 'gear' },
];

export function isRootRoute(route: Route): boolean {
  // 设置分区是 L2：要显示返回按钮（回设置首页），所以不算根页面；底栏仍通过 activeTabName 高亮「设置」。
  if (route.name === 'settings') return route.section === undefined;
  return route.name === 'sessions' || route.name === 'characters' || route.name === 'world';
}

/** 当前标签（二级页面归属它的来源标签，保证底栏高亮不闪）。 */
export function activeTabName(route: Route): Route['name'] {
  if (route.name === 'chat') return 'sessions';
  if (route.name === 'character' || route.name === 'import' || route.name === 'memories') return 'characters';
  if (route.name === 'lorebook' || route.name === 'lore') return 'lore';
  if (route.name === 'worldCard') return 'world';
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
    case 'import':
    case 'memories':
      return { name: 'characters' };
    case 'lorebook':
      return { name: 'lore' };
    case 'worldCard':
      return { name: 'world', kind: route.kind };
    case 'settings':
      // 设置首页是 L1；分区页一次返回回首页（不是回会话页）
      return route.section === undefined ? undefined : { name: 'settings' };
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
