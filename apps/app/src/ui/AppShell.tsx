import type { ReactNode } from 'react';
import { activeTabName, TABS, type Route } from '../app/router.ts';
import { useT } from '../i18n/context.tsx';
import { Icon, IconButton, type IconName } from './components.tsx';

export interface AppShellProps {
  route: Route;
  title: string;
  subtitle?: string;
  onBack?: () => void;
  actions?: ReactNode;
  onNavigate: (route: Route) => void;
  children: ReactNode;
  /** 聊天页需要把输入栏固定到底部，因此主区不滚动、由内容自己滚。 */
  layout?: 'scroll' | 'fill';
  /** 二级页面（聊天/角色编辑）隐藏标签栏：底部空间留给输入栏或主操作。 */
  hideTabs?: boolean;
}

/**
 * 应用外壳：顶栏 + 内容区 + 底部标签栏。
 *
 * 手机优先的三条硬约束都落在这里：
 *  1. 底栏标签是拇指可达区（高度 56 + 安全区），不放在顶部；
 *  2. 顶栏高度固定 56，标题单行省略，返回按钮在左、操作在右（两侧各 44px 触控目标）；
 *  3. 主区是唯一的滚动容器，`layout: 'fill'` 时交给子内容自己管滚动（聊天用）。
 */
export function AppShell({
  route,
  title,
  subtitle,
  onBack,
  actions,
  onNavigate,
  children,
  layout = 'scroll',
  hideTabs = false,
}: AppShellProps): ReactNode {
  const t = useT();
  const active = activeTabName(route);

  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar__left">
          {onBack !== undefined ? (
            <IconButton icon="back" label={t('common.back')} onClick={onBack} />
          ) : (
            <span className="appbar__spacer" />
          )}
        </div>
        <div className="appbar__center">
          <h1 className="appbar__title">{title}</h1>
          {subtitle !== undefined && <p className="appbar__subtitle">{subtitle}</p>}
        </div>
        <div className="appbar__right">{actions}</div>
      </header>

      <main className={layout === 'fill' ? 'screen screen--fill' : 'screen'}>{children}</main>

      {!hideTabs && (
        <nav className="tabbar" aria-label={t('tab.nav')}>
          {TABS.map((tab) => {
            const isActive = active === tab.route.name;
            return (
              <button
                key={tab.label}
                type="button"
                className={`tab${isActive ? ' tab--active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onNavigate(tab.route)}
              >
                <Icon name={tab.icon as IconName} size={22} />
                <span className="tab__label">{t(tab.label)}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
