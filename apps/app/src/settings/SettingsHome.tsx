import { useMemo, useState, type ReactNode } from 'react';
import type { SettingsSection } from '../app/router.ts';
import { formatTime } from '../data/repository.ts';
import { SETTING_KEYS } from '../data/types.ts';
import { useT } from '../i18n/context.tsx';
import { useAppState } from '../screens/screen-props.ts';
import { SettingsRow } from '../ui/SettingsRow.tsx';
import {
  buildSettingsIndex,
  defaultLocale,
  filterSettings,
  localeLabel,
  rowIdOf,
  syncKindShort,
} from './settings-index.ts';
import { SETTINGS_SECTION_LABEL, type SettingsProps } from './settings-types.ts';

/**
 * 设置首页（L1）。
 *
 * 只放 5 个分区入口 + 关于：每行 = 标签 + 当前值 + 箭头（信息气味），
 * 顶部搜索匹配所有 L2 行的标题 / 当前值 / 关键词，点结果直接进到对应详情的入口。
 */
export function SettingsHome({
  store,
  host,
  sync,
  tuner,
  plugins,
  locales,
  onOpen,
}: SettingsProps & {
  /** 第二个参数是"打开哪个 L2 行"（搜索命中时直达它的 L3）；普通入口不传。 */
  onOpen(section: SettingsSection, rowId?: string): void;
}): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [query, setQuery] = useState('');

  const locale = state.settings[SETTING_KEYS.locale] ?? defaultLocale(locales);
  const entries = useMemo(
    () =>
      buildSettingsIndex({
        t,
        settings: state.settings,
        characters: state.characters.length,
        sessions: state.sessions.length,
        locale,
        plugins: plugins.length,
        hostAvailable: host.available,
        hasSecret: sync?.hasSecret === true,
        hasSync: sync !== undefined,
        hasTuner: tuner !== undefined,
      }),
    [t, state.settings, state.characters.length, state.sessions.length, locale, plugins.length, host.available, sync?.hasSecret, sync, tuner],
  );
  const results = filterSettings(entries, query);

  const valueOf = (id: string): string => entries.find((item) => item.id === id)?.value ?? '';
  const kind = state.settings[SETTING_KEYS.syncKind] || 'off';
  const lastAt = Number(state.settings[SETTING_KEYS.syncLastAt] ?? '');
  const lastSync =
    Number.isFinite(lastAt) && lastAt > 0
      ? t('settings.sync.lastAt', { time: formatTime(lastAt) })
      : t('settings.sync.never');
  const syncValue =
    kind === 'off'
      ? t('settings.home.syncOff')
      : t('settings.home.syncValue', { kind: syncKindShort(t, kind), time: lastSync });

  const theme = state.settings[SETTING_KEYS.theme] || 'dark';
  const font = state.settings[SETTING_KEYS.fontScale] || 'normal';
  const appearanceValue = t('settings.home.appearanceValue', {
    theme: t(`settings.theme.${theme === 'light' || theme === 'system' ? theme : 'dark'}`),
    font: t(`settings.fontScale.${font === 'small' || font === 'large' ? font : 'normal'}`),
    locale: localeLabel(t, locale),
  });

  const group = (section: SettingsSection, value: string): ReactNode => (
    <SettingsRow
      key={section}
      label={t(SETTINGS_SECTION_LABEL[section])}
      value={value}
      onPress={() => onOpen(section)}
      testId={`settings-section-${section}`}
    />
  );

  return (
    <div className="settings-home" data-testid="settings-home">
      <input
        className="input settings-home__search"
        type="search"
        value={query}
        placeholder={t('settings.home.searchPlaceholder')}
        aria-label={t('settings.home.searchLabel')}
        onChange={(event) => setQuery(event.target.value)}
      />

      {query.trim() === '' ? (
        <>
          <div className="settings-home__list">
            {group('model', valueOf('model.chat'))}
            {group('appearance', appearanceValue)}
            {group('sync', syncValue)}
            {group('data', valueOf('data.local'))}
            {group('advanced', t('settings.home.plugins', { count: plugins.length }))}
          </div>
          <div className="settings-home__list settings-home__list--about">
            <SettingsRow
              label={t('settings.section.about')}
              value={t('settings.home.aboutValue', {
                version: t('settings.about.versionValue'),
                license: t('settings.about.licenseValue'),
              })}
              onPress={() => onOpen('about')}
              testId="settings-section-about"
            />
          </div>
        </>
      ) : (
        <div className="settings-home__list">
          {results.length === 0 && <p className="settings-home__empty">{t('settings.home.searchEmpty')}</p>}
          {results.map((entry) => (
            <SettingsRow
              key={entry.id}
              label={entry.label}
              value={`${t(SETTINGS_SECTION_LABEL[entry.section])} · ${entry.value}`}
              onPress={() => onOpen(entry.section, rowIdOf(entry))}
              testId={`settings-search-result-${entry.id}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
