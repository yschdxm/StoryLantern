import type { ReactNode } from 'react';
import { useT } from '../i18n/context.tsx';
import { useAppState } from '../screens/screen-props.ts';
import { BackupPanel } from '../screens/BackupPanel.tsx';
import { ProfilesPanel } from '../screens/ProfilesPanel.tsx';
import { AssetSelfTest } from './AssetSelfTest.tsx';
import { SettingsRow } from '../ui/SettingsRow.tsx';
import { SettingsDetail, SettingsList, useSectionDetail } from './SettingsSection.tsx';
import type { SettingsProps } from './settings-types.ts';

/**
 * 数据与备份（L2）。
 *
 * 整体备份/配置文件是重面板，进 L3；导入是跳转；本地数据是只读行
 * （数量 + 存哪里，给"我的数据在不在"一个直接答案）。
 */
export function DataSettings({ store, router, host, sync, initialRow }: SettingsProps & { initialRow?: string | undefined }): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const { detail, open, close } = useSectionDetail(initialRow);

  const counts = t('settings.home.dataValue', {
    sessions: t('count.sessions', { count: state.sessions.length }),
    characters: t('count.characters', { count: state.characters.length }),
    store: host.available ? t('settings.data.store.host') : t('settings.data.store.browser'),
  });

  if (detail !== undefined) {
    const titleKey =
      detail === 'backup' ? 'settings.row.backup' : detail === 'profile' ? 'settings.row.profile' : 'settings.row.assetSelfTest';
    return (
      <SettingsDetail section="data" titleKey={titleKey} onBack={close}>
        {detail === 'backup' && sync !== undefined && <BackupPanel sync={sync} />}
        {detail === 'profile' && <ProfilesPanel store={store} />}
        {detail === 'assets' && <AssetSelfTest />}
      </SettingsDetail>
    );
  }

  return (
    <SettingsList testId="settings-section-data-page">
      {sync !== undefined && (
        <SettingsRow label={t('settings.row.backup')} value={t('settings.value.backup')} onPress={() => open('backup')} />
      )}
      <SettingsRow label={t('settings.row.profile')} value={t('settings.value.profile')} onPress={() => open('profile')} />
      <SettingsRow
        label={t('settings.row.assetSelfTest')}
        value={t('settings.value.assetSelfTest')}
        onPress={() => open('assets')}
      />
      <SettingsRow label={t('import.title')} value={t('settings.value.import')} onPress={() => router.navigate({ name: 'import' })} />
      <SettingsRow label={t('settings.row.localData')} value={counts} arrow={false} />
    </SettingsList>
  );
}
