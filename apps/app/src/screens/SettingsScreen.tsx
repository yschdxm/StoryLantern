import { useEffect, useState, type ReactNode } from 'react';
import type { SettingsSection } from '../app/router.ts';
import { useT } from '../i18n/context.tsx';
import { AboutSettings } from '../settings/AboutSettings.tsx';
import { AdvancedSettings } from '../settings/AdvancedSettings.tsx';
import { AppearanceSettings } from '../settings/AppearanceSettings.tsx';
import { DataSettings } from '../settings/DataSettings.tsx';
import { ModelSettings } from '../settings/ModelSettings.tsx';
import { SettingsHome } from '../settings/SettingsHome.tsx';
import { SyncSettings } from '../settings/SyncSettings.tsx';
import { SETTINGS_SECTION_LABEL, type SettingsProps } from '../settings/settings-types.ts';

export type SettingsScreenProps = SettingsProps;

/**
 * 设置页外壳。
 *
 * 路由是唯一事实源：`#/settings` 渲染 L1 首页，`#/settings/<section>` 渲染对应 L2；
 * L3（分区内的详情/编辑）是页内状态，返回键一次回 L2 列表。
 * 所有内容都搬进了 `settings/` 下的分区页，这里只做"面包屑 + 按 section 分发"。
 */
export function SettingsScreen(props: SettingsScreenProps): ReactNode {
  const t = useT();
  const { router } = props;
  const [route, setRoute] = useState(() => router.current());
  /** 搜索命中时带上的目标行：分区页据此直接打开对应 L3。 */
  const [pending, setPending] = useState<{ section: SettingsSection; row: string } | undefined>(undefined);

  // 直接打开 #/settings/sync、或底栏/返回键切换 hash 时，靠订阅拿到最新 route
  useEffect(() => router.subscribe(setRoute), [router]);

  const section = route.name === 'settings' ? route.section : undefined;

  if (section === undefined) {
    return (
      <SettingsHome
        {...props}
        onOpen={(target, row) => {
          setPending(row === undefined ? undefined : { section: target, row });
          router.navigate({ name: 'settings', section: target });
        }}
      />
    );
  }

  const initialRow = pending !== undefined && pending.section === section ? pending.row : undefined;
  const common = { ...props, initialRow };

  return (
    <div className="settings-shell" data-testid={`settings-section-${section}-root`}>
      <nav className="settings-breadcrumb" aria-label={t('settings.breadcrumb.label')}>
        <button type="button" className="settings-breadcrumb__link" onClick={() => router.back()}>
          {t('settings.section.home')}
        </button>
        <span className="settings-breadcrumb__sep" aria-hidden="true">
          /
        </span>
        <span className="settings-breadcrumb__current">{t(SETTINGS_SECTION_LABEL[section])}</span>
      </nav>

      {section === 'model' && <ModelSettings {...common} />}
      {section === 'appearance' && <AppearanceSettings {...common} />}
      {section === 'sync' && <SyncSettings {...common} />}
      {section === 'data' && <DataSettings {...common} />}
      {section === 'advanced' && <AdvancedSettings {...common} />}
      {section === 'about' && <AboutSettings />}
    </div>
  );
}
