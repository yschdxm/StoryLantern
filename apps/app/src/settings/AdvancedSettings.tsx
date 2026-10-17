import type { ReactNode } from 'react';
import { useT } from '../i18n/context.tsx';
import { HostPanel } from '../HostPanel.tsx';
import { TunerPanel } from '../screens/TunerPanel.tsx';
import { SettingsRow } from '../ui/SettingsRow.tsx';
import { SettingsDetail, SettingsList, useSectionDetail } from './SettingsSection.tsx';
import type { SettingsProps } from './settings-types.ts';

/**
 * 高级与开发者（L2）。
 *
 * 默认"高级不前置"：这一屏只列 3 个入口，重面板（调优/插件/宿主诊断）都在 L3，
 * 用户不点进来就不会被 270 行的诊断信息淹没。
 */
export function AdvancedSettings({ store, host, ops, tuner, plugins, initialRow }: SettingsProps & { initialRow?: string | undefined }): ReactNode {
  const t = useT();
  const { detail, open, close } = useSectionDetail(initialRow);

  if (detail !== undefined) {
    return (
      <SettingsDetail
        section="advanced"
        titleKey={detail === 'tuner' ? 'settings.row.tuner' : detail === 'plugins' ? 'settings.plugins' : 'settings.developer'}
        onBack={close}
      >
        {detail === 'tuner' && tuner !== undefined && <TunerPanel tuner={tuner} />}
        {detail === 'plugins' && (
          <section className="settings-group">
            <ul className="chips">
              {plugins.map((plugin) => (
                <li key={plugin.id} className={`chip chip--${plugin.status}`}>
                  {plugin.id}
                  <small>{plugin.status}</small>
                </li>
              ))}
            </ul>
            <p className="muted">{t('settings.plugins.note')}</p>
          </section>
        )}
        {detail === 'developer' && <HostPanel client={host} {...(ops === undefined ? {} : { ops })} />}
      </SettingsDetail>
    );
  }

  return (
    <SettingsList testId="settings-section-advanced-page">
      {tuner !== undefined && (
        <SettingsRow label={t('settings.row.tuner')} value={t('settings.value.tuner')} onPress={() => open('tuner')} />
      )}
      <SettingsRow
        label={t('settings.plugins')}
        value={t('settings.home.plugins', { count: plugins.length })}
        onPress={() => open('plugins')}
      />
      <SettingsRow label={t('settings.developer')} value={t('settings.value.developer')} onPress={() => open('developer')} />
    </SettingsList>
  );
}
