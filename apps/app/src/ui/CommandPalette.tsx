import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n/context.tsx';
import { filterCommands, nextIndex, type PaletteCommand } from './command-palette.ts';

/**
 * Ctrl/Cmd+K 命令面板：一个输入框 + 一列可跳转的页面。
 *
 * 交互约束（手机优先 + 桌面顺手）：
 *  - 桌面：Ctrl+K / Cmd+K 打开，↑↓ 选择、Enter 进入、Esc 关闭；
 *  - 手机：从顶部菜单或键盘打开后，点条目即可；点遮罩关闭。
 * 面板**不写任何数据**，只做路由跳转 —— 会改数据的动作留在各页面自己的菜单里。
 */
export interface CommandPaletteProps {
  open: boolean;
  commands: readonly PaletteCommand[];
  onClose: () => void;
  onRun: (command: PaletteCommand) => void;
}

export function CommandPalette({ open, commands, onClose, onRun }: CommandPaletteProps): ReactNode {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const t = useT();

  const filtered = useMemo(() => filterCommands(query, commands), [query, commands]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // 等一帧再聚焦：移动端 WebView 里同步 focus 有时不弹出键盘
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // Esc 在窗口级也接一次：焦点可能不在输入框上（比如刚打开、还没 focus 完），
    // 只在 input 的 onKeyDown 里处理会让"按 Esc 没反应"（e2e 抓到的就是这个）。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const run = (command: PaletteCommand | undefined): void => {
    if (command === undefined) return;
    onRun(command);
    onClose();
  };

  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label={t('palette.label')} onMouseDown={onClose}>
      <div className="palette__box" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          placeholder={t('palette.placeholder')}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((current) => nextIndex(current, 1, filtered.length));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((current) => nextIndex(current, -1, filtered.length));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              run(filtered[active]);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <ul className="palette__list" role="listbox">
          {filtered.length === 0 && <li className="palette__empty">{t('palette.empty')}</li>}
          {filtered.map((command, index) => (
            <li key={command.id} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={`palette__item${index === active ? ' palette__item--active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(command)}
              >
                <span className="palette__label">{command.label}</span>
                {command.hint !== undefined && <span className="palette__hint">{command.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
