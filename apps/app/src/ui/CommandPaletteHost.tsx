import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { TABS, type Route } from '../app/router.ts';
import { useT } from '../i18n/context.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import type { PaletteCommand } from './command-palette.ts';

/**
 * 命令面板的宿主：负责快捷键、开关状态与命令清单，`main.tsx` 只挂一行。
 *
 * 为什么单独一个文件：`main.tsx` 已经贴着 400 行上限（门禁硬约束），
 * 把这套状态搬出来既守住了上限，也让面板能独立演进（换数据源不需要动根组件）。
 */
export interface CommandPaletteHostProps {
  onNavigate: (route: Route) => void;
}

export function CommandPaletteHost({ onNavigate }: CommandPaletteHostProps): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const commands: PaletteCommand[] = useMemo(
    () => [
      ...TABS.map((tab) => ({ id: tab.route.name, label: t(tab.label), hint: t('tab.nav'), route: tab.route })),
      { id: 'import', label: t('import.title'), hint: t('tab.nav'), route: { name: 'import' as const } },
    ],
    [t],
  );

  return (
    <CommandPalette
      open={open}
      commands={commands}
      onClose={() => setOpen(false)}
      onRun={(command) => onNavigate(command.route)}
    />
  );
}
