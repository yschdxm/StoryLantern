import type { ReactNode } from 'react';

/** 内联 SVG 图标：不引图标库，避免多一个依赖与字体加载抖动。全部 24×24、stroke 描边。 */
export type IconName = 'chat' | 'user' | 'gear' | 'back' | 'plus' | 'more' | 'send' | 'trash' | 'edit' | 'check' | 'warn' | 'stop';

const PATHS: Record<IconName, ReactNode> = {
  chat: <path d="M4 5h16v11H8l-4 3z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M4.9 7.5l2.2 1.2M16.9 15.3l2.2 1.2M4.9 16.5l2.2-1.2M16.9 8.7l2.2-1.2" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  more: (
    <>
      <circle cx="12" cy="5.5" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="12" cy="18.5" r="1.4" />
    </>
  ),
  send: <path d="M4 12l16-8-6 8 6 8z" />,
  trash: <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" />,
  edit: <path d="M5 19h3l10-10-3-3L5 16zM14 6l3 3" />,
  check: <path d="M5 13l4 4L19 7" />,
  warn: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
};

export function Icon({ name, size = 22 }: { name: IconName; size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  block = false,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  block?: boolean;
  type?: 'button' | 'submit';
}): ReactNode {
  return (
    <button
      type={type}
      className={`btn btn--${variant}${block ? ' btn--block' : ''}`}
      disabled={disabled}
      onClick={onClick}
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

export function LoadingState({ label = '正在加载…' }: { label?: string }): ReactNode {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="muted">{label}</span>
    </div>
  );
}

export function ListRow({
  title,
  subtitle,
  meta,
  onClick,
  trailing,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  onClick?: () => void;
  trailing?: ReactNode;
}): ReactNode {
  return (
    <li className="list__item">
      <button type="button" className="list__row" onClick={onClick} disabled={onClick === undefined}>
        <span className="list__main">
          <span className="list__title">{title}</span>
          {subtitle !== undefined && <span className="list__sub">{subtitle}</span>}
        </span>
        {meta !== undefined && <span className="list__meta">{meta}</span>}
      </button>
      {trailing !== undefined && <span className="list__trailing">{trailing}</span>}
    </li>
  );
}

/** 底部动作面板：重命名/删除这类二级操作放这里，主列表保持干净。 */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  /** 允许显式 undefined：调用方常写 `title={maybe?.title}`。 */
  title?: string | undefined;
  onClose: () => void;
  children: ReactNode;
}): ReactNode {
  if (!open) return null;
  return (
    <div className="sheet" role="dialog" aria-modal="true">
      <button type="button" className="sheet__backdrop" aria-label="关闭" onClick={onClose} />
      <div className="sheet__panel">
        {title !== undefined && <p className="sheet__title">{title}</p>}
        {children}
      </div>
    </div>
  );
}

export function SheetItem({
  icon,
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  icon?: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}): ReactNode {
  return (
    <button type="button" className={`sheet__item${danger ? ' sheet__item--danger' : ''}`} onClick={onClick} disabled={disabled}>
      {icon !== undefined && <Icon name={icon} size={20} />}
      <span>{label}</span>
    </button>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '删除',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactNode {
  if (!open) return null;
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <button type="button" className="modal__backdrop" aria-label="取消" onClick={onCancel} />
      <div className="modal__panel">
        <p className="modal__title">{title}</p>
        <p className="modal__message">{message}</p>
        <div className="modal__actions">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactNode {
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
  onBlur,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password' | 'url';
  autoFocus?: boolean;
  /** 失焦时提交（设置页靠它做到"改完立即生效"，不必再放保存按钮）。 */
  onBlur?: () => void;
}): ReactNode {
  return (
    <input
      className="input"
      type={type}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
      {...(onBlur === undefined ? {} : { onBlur })}
    />
  );
}

export function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}): ReactNode {
  return (
    <textarea
      className="textarea"
      rows={rows}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
