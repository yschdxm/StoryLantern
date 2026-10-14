import type { ReactNode } from 'react';

/** 内联 SVG 图标：不引图标库，避免多一个依赖与字体加载抖动。全部 24×24、stroke 描边。 */
export type IconName =
  | 'chat'
  | 'user'
  | 'gear'
  | 'back'
  | 'plus'
  | 'more'
  | 'send'
  | 'trash'
  | 'edit'
  | 'check'
  | 'warn'
  | 'stop'
  | 'import'
  | 'download';

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
  import: <path d="M12 4v10M8 10l4 4 4-4M5 19h14" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />,
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
