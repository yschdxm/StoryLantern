import type {
  Disposer,
  LocaleMessages,
  LocaleRegistration,
  LocaleService,
  MissingTranslation,
  TranslateParams,
} from '../../plugin-api/src/contract.ts';

/**
 * 国际化实现（契约在 `@storylantern/plugin-api`）。
 *
 * 三条刻意的取舍：
 *  1. **缺翻译不崩**：返回 key 本身并记入 `missing()`。UI 上看到 `chat.send` 比整个面板白屏好得多；
 *     开发/CI 可以用 `strict: true` 把它变成硬失败。
 *  2. **回退链显式**：`zh-Hans-CN` 这类标签归一成 `zh-CN`，再退到 `zh`、再到配置的回退列表（默认 en）。
 *  3. **复数交给 Intl.PluralRules**：中文只有 other，英文分 one/other，规则不写死在代码里。
 */

export const DEFAULT_LOCALE = 'zh-CN';
export const DEFAULT_FALLBACKS: readonly string[] = ['zh-CN', 'zh', 'en'];

/**
 * 归一化语言标签：只保留"语言 + 两位地区/三位数字"，丢掉 script（Hans/Hant）。
 * 我们按 `zh-CN` / `zh-TW` / `en` 这个粒度维护文案，写上 Hans 只会让查找变复杂。
 */
export function normalizeLocale(tag: string): string {
  const cleaned = tag.trim().replace(/_/g, '-');
  if (cleaned === '') return '';
  const parts = cleaned.split('-');
  const language = (parts[0] ?? '').toLowerCase();
  const region = parts.slice(1).find((part) => part.length === 2 || /^\d{3}$/.test(part));
  return region ? `${language}-${region.toUpperCase()}` : language;
}

/** 语言标签的查找链：具体 → 语言 → 配置的回退（同样各自展开语言级）。 */
export function localeChain(locale: string, fallbacks: readonly string[] = DEFAULT_FALLBACKS): string[] {
  const chain: string[] = [];
  const push = (value: string): void => {
    const normalized = normalizeLocale(value);
    if (normalized !== '' && !chain.includes(normalized)) chain.push(normalized);
  };
  push(locale);
  push(locale.split('-')[0] ?? '');
  for (const fallback of fallbacks) {
    push(fallback);
    push(fallback.split('-')[0] ?? '');
  }
  return chain;
}

/** 从系统/宿主给的偏好列表里挑一个我们支持的语言。 */
export function detectLocale(
  hints: readonly string[],
  options: { supported?: readonly string[]; fallbacks?: readonly string[] } = {},
): string {
  const supported = options.supported ?? [];
  for (const hint of hints) {
    const normalized = normalizeLocale(hint);
    if (normalized === '') continue;
    if (supported.length === 0) return normalized;
    if (supported.includes(normalized)) return normalized;
    const language = normalized.split('-')[0] ?? '';
    const match = supported.find((item) => normalizeLocale(item).split('-')[0] === language);
    if (match) return normalizeLocale(match);
  }
  return '';
}

/** 运行时能拿到的语言偏好（浏览器/WebView 有 navigator，Node 用 Intl）。 */
export function systemLocaleHints(): string[] {
  const hints: string[] = [];
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  if (nav?.languages) hints.push(...nav.languages);
  if (nav?.language) hints.push(nav.language);
  try {
    const resolved = new Intl.DateTimeFormat().resolvedOptions().locale;
    if (resolved) hints.push(resolved);
  } catch {
    // 某些精简运行时没有 Intl 数据，忽略即可
  }
  return hints;
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** `{{name}}` 插值；缺参数时**保留占位符**，让漏配在界面上一眼可见。 */
export function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export interface LocaleServiceOptions {
  locale?: string;
  fallbacks?: readonly string[];
  /** true 时缺翻译直接抛错（CI/开发期用），默认 false。 */
  strict?: boolean;
  onMissing?: (missing: MissingTranslation) => void;
}

export function createLocaleService(options: LocaleServiceOptions = {}): LocaleService {
  /** locale -> namespace -> messages */
  const bundles = new Map<string, Map<string, LocaleMessages>>();
  const fallbacks = options.fallbacks ?? DEFAULT_FALLBACKS;
  const missingList: MissingTranslation[] = [];
  const strict = options.strict === true;

  let current = normalizeLocale(options.locale ?? '') || DEFAULT_LOCALE;

  const namespacesFor = (locale: string): Map<string, LocaleMessages> | undefined => bundles.get(locale);

  const lookup = (key: string, namespace?: string): { value: string; namespace: string } | undefined => {
    for (const locale of localeChain(current, fallbacks)) {
      const byNamespace = namespacesFor(locale);
      if (!byNamespace) continue;
      const order = namespace === undefined
        ? [...byNamespace.keys()]
        : [namespace, ...[...byNamespace.keys()].filter((item) => item !== namespace)];
      for (const ns of order) {
        const value = byNamespace.get(ns)?.[key];
        if (typeof value === 'string') return { value, namespace: ns };
      }
    }
    return undefined;
  };

  const pluralCategory = (count: number, locale: string): string => {
    try {
      return new Intl.PluralRules(locale).select(count);
    } catch {
      return 'other';
    }
  };

  const service: LocaleService = {
    get locale(): string {
      return current;
    },

    t(key: string, params?: TranslateParams, translateOptions?: { namespace?: string }): string {
      const count = typeof params?.count === 'number' ? params.count : undefined;
      const candidates: string[] = [];
      if (count !== undefined) {
        const category = pluralCategory(count, current);
        candidates.push(`${key}.${category}`, `${key}.other`);
        if (category !== 'one') candidates.push(`${key}.one`);
      }
      candidates.push(key);

      for (const candidate of candidates) {
        const hit = lookup(candidate, translateOptions?.namespace);
        if (hit) return interpolate(hit.value, params);
      }

      const missing: MissingTranslation = {
        namespace: translateOptions?.namespace ?? '(auto)',
        key,
        locale: current,
      };
      missingList.push(missing);
      options.onMissing?.(missing);
      if (strict) throw new Error(`缺少翻译：${missing.namespace}/${key} (${current})`);
      return key;
    },

    setLocale(locale: string): boolean {
      const normalized = normalizeLocale(locale);
      if (normalized === '' || normalized === current) return false;
      current = normalized;
      return true;
    },

    supports(locale: string): boolean {
      const normalized = normalizeLocale(locale);
      if (normalized === '') return false;
      if (bundles.has(normalized)) return true;
      const language = normalized.split('-')[0] ?? '';
      for (const key of bundles.keys()) {
        if ((key.split('-')[0] ?? '') === language) return true;
      }
      return false;
    },

    register(registration: LocaleRegistration): Disposer {
      const namespace = registration.namespace.trim();
      const locale = normalizeLocale(registration.locale);
      if (namespace === '') throw new Error('语言包必须声明 namespace');
      if (locale === '') throw new Error('语言包必须声明 locale');

      let byNamespace = bundles.get(locale);
      if (!byNamespace) {
        byNamespace = new Map();
        bundles.set(locale, byNamespace);
      }
      if (byNamespace.has(namespace)) {
        throw new Error(`语言包冲突：${namespace}@${locale} 已注册（先撤销旧的再注册）`);
      }
      byNamespace.set(namespace, registration.messages);

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const currentBundles = bundles.get(locale);
        if (!currentBundles) return;
        currentBundles.delete(namespace);
        if (currentBundles.size === 0) bundles.delete(locale);
      };
    },

    locales(): string[] {
      return [...bundles.keys()].sort();
    },

    missing(): MissingTranslation[] {
      return [...missingList];
    },

    clearMissing(): void {
      missingList.length = 0;
    },
  };

  return service;
}
