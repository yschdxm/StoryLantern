import type { ReactNode } from 'react';
import { useT } from '../i18n/context.tsx';
import { SettingsRow } from '../ui/SettingsRow.tsx';
import { SettingsList } from './SettingsSection.tsx';

/**
 * 关于（L1 的最后一组）。
 *
 * 版本号/构建时间/许可证从设置正文移到这里：它们是"关于这个应用"的信息，
 * 不是用户会改的设置项（Material：Help/About 与 Settings 分开）。
 */
export function AboutSettings(): ReactNode {
  const t = useT();

  return (
    <>
      <SettingsList testId="settings-section-about-page">
        <SettingsRow label={t('settings.row.version')} value={t('settings.about.versionValue')} arrow={false} />
        <SettingsRow label={t('settings.row.build')} value={__BUILD_STAMP__} arrow={false} />
        <SettingsRow label={t('settings.row.license')} value={t('settings.about.licenseValue')} arrow={false} />
      </SettingsList>
      <p className="muted settings-about__note">{t('settings.about.note')}</p>
    </>
  );
}
