import { useEffect, useState, type ReactNode } from 'react';
import type { SettingsSection } from '../app/router.ts';
import { useT } from '../i18n/context.tsx';
import { Button } from '../ui/components.tsx';
import { SETTINGS_SECTION_LABEL } from './settings-types.ts';

/** L3 详情页内的局部状态；从搜索直达时把 initialRow 打开。 */
export function useSectionDetail(initialRow?: string): {
  detail: string | undefined;
  open: (row: string) => void;
  close: () => void;
} {
  const [detail, setDetail] = useState<string | undefined>(initialRow);
  useEffect(() => {
    if (initialRow !== undefined) setDetail(initialRow);
  }, [initialRow]);
  return {
    detail,
    open: (row: string) => setDetail(row),
    close: () => setDetail(undefined),
  };
}

/** L2 分区页的列表壳（每行 = label + 当前值 + 箭头）。 */
export function SettingsList({ children, testId }: { children: ReactNode; testId?: string }): ReactNode {
  return (
    <div className="settings-list" {...(testId === undefined ? {} : { 'data-testid': testId })}>
      {children}
    </div>
  );
}

/**
 * L3 详情/编辑页的壳：一条"返回分区"的 ghost 按钮 + 标题 + 内容。
 *
 * 为什么 L3 不占路由：设置分区内部再分层只影响内容，不影响"设置"这个标签的归属；
 * 系统返回键从分区页回设置首页（P1-a 的 parentOf），页内返回键从 L3 回 L2 列表。
 */
export function SettingsDetail({
  section,
  titleKey,
  onBack,
  children,
}: {
  section: SettingsSection;
  titleKey: string;
  onBack: () => void;
  children: ReactNode;
}): ReactNode {
  const t = useT();
  return (
    <div className="settings-detail" data-testid={`settings-detail-${section}`}>
      <Button variant="ghost" onClick={onBack}>
        ← {t('settings.detail.back', { section: t(SETTINGS_SECTION_LABEL[section]) })}
      </Button>
      <h2 className="settings-detail__title">{t(titleKey)}</h2>
      {children}
    </div>
  );
}
