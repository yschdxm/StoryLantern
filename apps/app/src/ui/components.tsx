import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n/context.tsx';
import { Icon, type IconName } from './icons.tsx';

// 图标与窗口化拆到各自文件（单一职责 + 单文件行数保持可读），这里统一再导出，调用方只认一个入口。
export { Icon } from './icons.tsx';
export type { IconName } from './icons.tsx';
export { LoadMore, useWindowedList } from './windowing.tsx';

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  block = false,
  type = 'button',
  testId,
}: {
  children: ReactNode; onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger' | 'accent-ghost';
  disabled?: boolean; block?: boolean;
  type?: 'button' | 'submit';
  /** 端到端测试用的稳定选择器（只加属性，不改行为）。 */
  testId?: string;
}): ReactNode {
  return (
    <button
      type={type}
      className={`btn btn--${variant}${block ? ' btn--block' : ''}`}
      disabled={disabled}
      onClick={onClick}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    >
      {children}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}): ReactNode {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName;
  title: string;
  hint?: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={30} />
      </div>
      <p className="empty__title">{title}</p>
      {hint !== undefined && <p className="empty__hint">{hint}</p>}
      {action !== undefined && <div className="empty__action">{action}</div>}
    </div>
  );
}

export function Banner({
  tone = 'warn',
  children,
  action,
}: {
  tone?: 'warn' | 'error' | 'info';
  children: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className={`banner banner--${tone}`} role="status">
      <span className="banner__text">{children}</span>
      {action !== undefined && <span className="banner__action">{action}</span>}
    </div>
  );
}

export function LoadingState({ label }: { label?: string }): ReactNode {
  const t = useT();
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label ?? t('sessions.loading')}</span>
    </div>
  );
}

const SWIPE_REVEAL = 96;
const SWIPE_TRIGGER = 42;
const LONG_PRESS_MS = 480;

/**
 * 列表行。支持三种操作方式，都符合拇指习惯：
 *  - 点整行 → 主操作（进详情）；
 *  - 向左滑 → 露出删除（滑动手势只认"横向位移明显大于纵向"，不会抢页面滚动）；
 *  - 长按 → 打开操作面板（与右侧「⋯」等价，两个入口，不必记哪一个）。
 */
export function ListRow({
  title,
  subtitle,
  meta,
  onClick,
  trailing,
  onSwipeDelete,
  onLongPress,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  onClick?: () => void;
  trailing?: ReactNode;
  onSwipeDelete?: () => void;
  onLongPress?: () => void;
}): ReactNode {
  const t = useT();
  const [offset, setOffset] = useState(0);
  const drag = useRef<{ x: number; y: number; axis: 'none' | 'x' | 'y'; startOffset: number } | null>(null);
  const longPress = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const suppressClick = useRef(false);

  const clearLongPress = useCallback((): void => {
    if (longPress.current !== null) {
      globalThis.clearTimeout(longPress.current);
      longPress.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const swipeEnabled = onSwipeDelete !== undefined;

  return (
    <li className="list__item">
      {swipeEnabled && (
        <button
          type="button"
          className="list__delete"
          aria-label={t('common.delete')}
          onClick={() => {
            setOffset(0);
            onSwipeDelete?.();
          }}
        >
          <Icon name="trash" size={20} />
          <span>{t('common.delete')}</span>
        </button>
      )}

      <div
        className="list__slide"
        style={{
          transform: `translateX(${offset}px)`,
          transition: drag.current === null ? 'transform .18s ease-out' : 'none',
        }}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, axis: 'none', startOffset: offset };
          if (onLongPress !== undefined) {
            clearLongPress();
            longPress.current = globalThis.setTimeout(() => {
              longPress.current = null;
              suppressClick.current = true;
              onLongPress();
            }, LONG_PRESS_MS);
          }
        }}
        onPointerMove={(event) => {
          const state = drag.current;
          if (state === null) return;
          const dx = event.clientX - state.x;
          const dy = event.clientY - state.y;
          if (state.axis === 'none') {
            if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
            state.axis = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'x' : 'y';
            clearLongPress();
          }
          if (state.axis !== 'x' || !swipeEnabled) return;
          setOffset(Math.max(-SWIPE_REVEAL, Math.min(0, state.startOffset + dx)));
        }}
        onPointerUp={() => {
          clearLongPress();
          const state = drag.current;
          drag.current = null;
          if (state === null || state.axis !== 'x' || !swipeEnabled) return;
          setOffset(offset < -SWIPE_TRIGGER ? -SWIPE_REVEAL : 0);
        }}
        onPointerCancel={() => {
          clearLongPress();
          drag.current = null;
          setOffset(0);
        }}
      >
        <button
          type="button"
          className="list__row"
          onClick={() => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            if (offset !== 0) {
              setOffset(0);
              return;
            }
            onClick?.();
          }}
          disabled={onClick === undefined}
        >
          <span className="list__main">
            <span className="list__title">{title}</span>
            {subtitle !== undefined && <span className="list__sub">{subtitle}</span>}
          </span>
          {meta !== undefined && <span className="list__meta">{meta}</span>}
        </button>
        {trailing !== undefined && <span className="list__trailing">{trailing}</span>}
      </div>
    </li>
  );
}

/** 底部动作面板：重命名/删除这类二级操作放这里，主列表保持干净。 */
export function Sheet({ open, title, onClose, children }: {
  open: boolean; /** 允许显式 undefined：调用方常写 `title={maybe?.title}`。 */
  title?: string | undefined; onClose: () => void; children: ReactNode;
}): ReactNode {
  const t = useT();
  // 打开时锁住背景滚动：手机上一滑动背后列表就跟着动，是很典型的"不像原生"的观感
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;
  // 挂到 body：祖先带 backdrop-filter/transform 时会成为 position:fixed 的包含块，
  // 面板会被"钉"在那个祖先里（真机上表现为顶栏菜单跑到屏幕外）。
  return createPortal(
    <div className="sheet" role="dialog" aria-modal="true">
      <button type="button" className="sheet__backdrop" aria-label={t('common.close')} onClick={onClose} />
      <div className="sheet__panel">
        {title !== undefined && <p className="sheet__title">{title}</p>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function SheetItem({ icon, label, onClick, danger = false, disabled = false }: {
  icon?: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}): ReactNode {
  return (
    <button
      type="button"
      className={`sheet__item${danger ? ' sheet__item--danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {icon !== undefined && <Icon name={icon} size={20} />}
      <span>{label}</span>
    </button>
  );
}

export function ConfirmDialog({
  open, title, message, confirmLabel, onConfirm, onCancel,
}: {
  open: boolean; title: string; message: string;
  confirmLabel?: string; onConfirm: () => void; onCancel: () => void;
}): ReactNode {
  const t = useT();
  if (!open) return null;
  // 同 Sheet：挂到 body，避免被祖先的 backdrop-filter/transform 当包含块
  return createPortal(
    <div className="modal" role="dialog" aria-modal="true">
      <button type="button" className="modal__backdrop" aria-label={t('common.cancel')} onClick={onCancel} />
      <div className="modal__panel">
        <p className="modal__title">{title}</p>
        <p className="modal__message">{message}</p>
        <div className="modal__actions">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel ?? t('common.delete')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint !== undefined && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  autoFocus = false,
  disabled = false,
  onBlur,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string; type?: 'text' | 'password' | 'url' | 'number';
  autoFocus?: boolean;
  /** 失焦时提交（设置页靠它做到"改完立即生效"，不必再放保存按钮）。 */
  onBlur?: () => void;
  /** 灰掉且不可编辑：用于"这条设置当前不生效"（例如同步改走 SAF 目录时的宿主路径框）。 */
  disabled?: boolean;
  /** 端到端测试用的稳定选择器。 */
  testId?: string;
}): ReactNode {
  return (
    <input
      className="input"
      type={type}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      {...(onBlur === undefined ? {} : { onBlur })}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    />
  );
}

export function TextArea({
  value,
  onChange,
  onBlur,
  placeholder,
  rows = 4,
  testId,
}: {
  value: string; onChange: (value: string) => void;
  /** 文本类设置用它落库（与 TextInput 的 onBlur 对齐）。 */
  onBlur?: () => void;
  placeholder?: string; rows?: number;
  /** 端到端测试用的稳定选择器。 */
  testId?: string;
}): ReactNode {
  return (
    <textarea
      className="textarea"
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      {...(onBlur === undefined ? {} : { onBlur })}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
    />
  );
}
