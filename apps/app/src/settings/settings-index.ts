import type { SettingsSection } from '../app/router.ts';
import { formatTime } from '../data/repository.ts';
import { readProfiles } from '../data/model-routing.ts';
import { SETTING_KEYS, type SettingsMap } from '../data/types.ts';
import type { Translator } from '../i18n/locale.ts';

/**
 * 设置项的单一索引：L2 列表行、设置首页的"当前值"、搜索都用这一份数据。
 *
 * 为什么不各页各写一套：搜索要匹配"行标题 + 当前值 + 关键词"，
 * 如果搜索和列表各算一份，很容易出现"搜得到却点不到"或值不一致。
 * 这里只做纯计算（t 由调用方注入），页面只负责渲染。
 */
export interface SettingsIndexEntry {
  id: string;
  section: SettingsSection;
  label: string;
  value: string;
  keywords: string;
}

export interface SettingsIndexInput {
  t: Translator;
  settings: SettingsMap;
  characters: number;
  sessions: number;
  locale: string;
  plugins: number;
  hostAvailable: boolean;
  /** 当前同步口令是否已保存（只写；这里只显示"已设置/未设置"）。 */
  hasSecret?: boolean;
  /** 同步/调优面板是否挂载（没有它们的分区不该被搜索命中）。 */
  hasSync?: boolean;
  hasTuner?: boolean;
}

/** 当前同步方式的短标签（长标签留给分区页的选择器，首页行放不下）。 */
export function syncKindShort(t: Translator, kind: string): string {
  const safe = kind === 'webdav' || kind === 'folder' || kind === 's3' || kind === 'off' ? kind : 'off';
  return t(`settings.sync.short.${safe}`);
}

/**
 * 未保存语言设置时的默认语言。
 *
 * `locales()` 是排序过的（en 在 zh-CN 前），不能拿第一个当默认 —— 否则界面是中文、
 * 设置里却显示 English。应用默认语言与 i18n 的 DEFAULT_LOCALE 一致。
 */
export function defaultLocale(locales: readonly string[]): string {
  return locales.includes('zh-CN') ? 'zh-CN' : (locales[0] ?? '');
}

/** 语言名是专有名词，但仍走目录，避免组件里硬编码中英文。 */
export function localeLabel(t: Translator, locale: string): string {
  if (locale === 'zh-CN') return t('settings.lang.zh');
  if (locale === 'en') return t('settings.lang.en');
  return locale;
}

export function buildSettingsIndex(input: SettingsIndexInput): SettingsIndexEntry[] {
  const { t, settings, characters, sessions, locale, plugins, hostAvailable, hasSecret = false, hasSync = true, hasTuner = true } = input;
  const keyword = (section: SettingsSection): string => t(`settings.search.keywords.${section}`);
  const entry = (section: SettingsSection, id: string, label: string, value: string): SettingsIndexEntry => ({
    id: `${section}.${id}`,
    section,
    label,
    value,
    keywords: `${keyword(section)} ${label} ${value}`,
  });

  const model = settings[SETTING_KEYS.model] ?? '';
  const keySet = (settings[SETTING_KEYS.apiKey] ?? '') !== '';
  const modelValue =
    model === ''
      ? t('settings.home.unset')
      : t('settings.home.modelValue', {
          model,
          key: keySet ? t('settings.home.keySet') : t('settings.home.keyUnset'),
        });
  const theme = settings[SETTING_KEYS.theme] || 'dark';
  const font = settings[SETTING_KEYS.fontScale] || 'normal';
  const kind = settings[SETTING_KEYS.syncKind] || 'off';
  const lastAt = Number(settings[SETTING_KEYS.syncLastAt] ?? '');
  const lastSync = Number.isFinite(lastAt) && lastAt > 0 ? t('settings.sync.lastAt', { time: formatTime(lastAt) }) : t('settings.sync.never');
  const profiles = readProfiles(settings);
  const store = hostAvailable ? t('settings.data.store.host') : t('settings.data.store.browser');
  const connectionReady =
    kind === 'webdav'
      ? (settings[SETTING_KEYS.syncUrl] ?? '') !== ''
      : kind === 's3'
        ? (settings[SETTING_KEYS.syncS3Endpoint] ?? '') !== '' &&
          (settings[SETTING_KEYS.syncS3Bucket] ?? '') !== '' &&
          (settings[SETTING_KEYS.syncS3AccessKeyId] ?? '') !== ''
        : kind === 'folder';

  const entries: SettingsIndexEntry[] = [
    entry('model', 'chat', t('settings.row.chatModel'), modelValue),
    entry('model', 'profiles', t('settings.row.modelProfiles'), t('settings.home.profiles', { count: profiles.length })),
    entry('appearance', 'theme', t('settings.theme'), t(`settings.theme.${theme === 'light' || theme === 'system' ? theme : 'dark'}`)),
    entry('appearance', 'font', t('settings.fontScale'), t(`settings.fontScale.${font === 'small' || font === 'large' ? font : 'normal'}`)),
    entry('appearance', 'language', t('settings.language'), localeLabel(t, locale)),
  ];

  if (kind !== 'off') {
    entries.push(
      entry('sync', 'kind', t('settings.sync.kind'), syncKindShort(t, kind)),
      entry('sync', 'connection', t('settings.row.connection'), connectionReady ? t('settings.value.configured') : t('settings.value.connectionNeeded')),
      entry('sync', 'secret', t('settings.sync.secret'), hasSecret ? t('settings.value.secretSet') : t('settings.value.secretUnset')),
    );
    if (hasSync) {
      entries.push(
        entry('sync', 'devices', t('settings.row.devices'), t('settings.value.manage')),
        entry('sync', 'pairing', t('settings.row.pairing'), t('settings.value.pairing')),
        entry('sync', 'run', t('settings.row.run'), lastSync),
      );
    }
  } else {
    entries.push(entry('sync', 'kind', t('settings.sync.kind'), syncKindShort(t, kind)));
  }

  entries.push(
    ...(hasSync ? [entry('data', 'backup', t('settings.row.backup'), t('settings.value.backup'))] : []),
    entry('data', 'profile', t('settings.row.profile'), t('settings.value.profile')),
    entry('data', 'import', t('import.title'), t('settings.value.import')),
    entry(
      'data',
      'local',
      t('settings.row.localData'),
      t('settings.home.dataValue', {
        sessions: t('count.sessions', { count: sessions }),
        characters: t('count.characters', { count: characters }),
        store,
      }),
    ),
    ...(hasTuner ? [entry('advanced', 'tuner', t('settings.row.tuner'), t('settings.value.tuner'))] : []),
    entry('advanced', 'plugins', t('settings.plugins'), t('settings.home.plugins', { count: plugins })),
    entry('advanced', 'developer', t('settings.developer'), t('settings.value.developer')),
    entry('about', 'version', t('settings.row.version'), t('settings.about.versionValue')),
    entry('about', 'build', t('settings.row.build'), __BUILD_STAMP__),
    entry('about', 'license', t('settings.row.license'), t('settings.about.licenseValue')),
  );

  return entries;
}

/** 索引 id 是 `<section>.<row>`；分区页只认 row 部分（打开 L3 时用）。 */
export function rowIdOf(entry: SettingsIndexEntry): string {
  const prefix = `${entry.section}.`;
  return entry.id.startsWith(prefix) ? entry.id.slice(prefix.length) : entry.id;
}

/** 搜索：匹配行标题 / 当前值 / 关键词，大小写不敏感；空查询返回全部。 */
export function filterSettings(entries: readonly SettingsIndexEntry[], query: string): SettingsIndexEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter((item) => `${item.label} ${item.value} ${item.keywords}`.toLowerCase().includes(needle));
}
