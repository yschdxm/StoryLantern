import type { ReactNode } from 'react';
import { SETTING_KEYS } from '../data/types.ts';
import { useT } from '../i18n/context.tsx';
import { useAppState } from '../screens/screen-props.ts';
import { SettingsRow } from '../ui/SettingsRow.tsx';
import { SettingsList } from './SettingsSection.tsx';
import { defaultLocale, localeLabel } from './settings-index.ts';
import type { SettingsProps } from './settings-types.ts';
import { useSettingsDraft } from './use-settings-draft.ts';

/** 分段选择器：主题/字号这种"少量互斥选项"用它比下拉框少一次点击，也看得见当前值。 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}): ReactNode {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented__item${option.value === value ? ' segmented__item--active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 外观与语言（L2）：三行都在行内直接改、改完即生效（不需要 L3，也不该多一次点击）。
 * 次级文字只写当前值（暗色 / 标准 / 简体中文）。
 */
export function AppearanceSettings({ store, locales, onLocaleChange }: SettingsProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const { value, saveNow } = useSettingsDraft(store, state.settings);
  const theme = value(SETTING_KEYS.theme) === '' ? 'dark' : value(SETTING_KEYS.theme);
  const fontScale = value(SETTING_KEYS.fontScale) === '' ? 'normal' : value(SETTING_KEYS.fontScale);
  const locale = state.settings[SETTING_KEYS.locale] ?? defaultLocale(locales);

  return (
    <SettingsList testId="settings-section-appearance-page">
      <SettingsRow
        label={t('settings.theme')}
        control={
          <Segmented
            value={theme}
            onChange={(next) => saveNow(SETTING_KEYS.theme, next)}
            options={[
              { value: 'dark', label: t('settings.theme.dark') },
              { value: 'light', label: t('settings.theme.light') },
              { value: 'system', label: t('settings.theme.system') },
            ]}
          />
        }
      />
      <SettingsRow
        label={t('settings.fontScale')}
        control={
          <Segmented
            value={fontScale}
            onChange={(next) => saveNow(SETTING_KEYS.fontScale, next)}
            options={[
              { value: 'small', label: t('settings.fontScale.small') },
              { value: 'normal', label: t('settings.fontScale.normal') },
              { value: 'large', label: t('settings.fontScale.large') },
            ]}
          />
        }
      />
      {locales.length > 0 && (
        <SettingsRow
          label={t('settings.language')}
          value={localeLabel(t, locale)}
          control={
            <select className="input settings-row__select" value={locale} onChange={(event) => onLocaleChange(event.target.value)} aria-label={t('settings.language')}>
              {locales.map((item) => (
                <option key={item} value={item}>
                  {localeLabel(t, item)}
                </option>
              ))}
            </select>
          }
        />
      )}
    </SettingsList>
  );
}
