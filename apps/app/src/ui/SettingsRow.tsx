import type { ReactNode } from 'react';
import { Icon } from './icons.tsx';

/**
 * 设置列表行（L2 的统一行原语）。
 *
 * 信息气味：**标签 + 当前值**，当前值只写"现在是什么"，不写"这是干什么"（解释放 L3）。
 * 三种形态：
 *  - 可点行：label + value + 箭头（进 L3 详情/编辑）；
 *  - 只读行：label + value（没有可点的东西，例如版本号）；
 *  - 行内控件：label + control（主题/字号/同步方式这类改完即生效的选择）。
 *
 * 触控目标由 CSS 的 min-height: var(--tap-min) 保证 ≥44px。
 */
export function SettingsRow({
  label,
  value,
  onPress,
  control,
  arrow = true,
  disabled = false,
  testId,
}: {
  label: string;
  /** 当前值/状态（次级文字）。空串表示这一行没有次级文字。 */
  value?: string | undefined;
  onPress?: (() => void) | undefined;
  /** 行内控件（开关/三选一/选择器）；给了它就不再包成按钮。 */
  control?: ReactNode;
  /** 是否显示右侧箭头，默认在可点时显示。 */
  arrow?: boolean;
  disabled?: boolean;
  testId?: string;
}): ReactNode {
  const main = (
    <span className="settings-row__main">
      <span className="settings-row__label">{label}</span>
      {value !== undefined && value !== '' && <span className="settings-row__value">{value}</span>}
    </span>
  );
  const testAttribute = testId === undefined ? {} : { 'data-testid': testId };

  if (control !== undefined) {
    return (
      <div className="settings-row settings-row--control" {...testAttribute}>
        {main}
        <span className="settings-row__control">{control}</span>
      </div>
    );
  }

  if (onPress === undefined) {
    return (
      <div className="settings-row" {...testAttribute}>
        {main}
        {arrow && <span className="settings-row__arrow" aria-hidden="true" />}
      </div>
    );
  }

  return (
    <button type="button" className="settings-row settings-row--button" onClick={onPress} disabled={disabled} {...testAttribute}>
      {main}
      {arrow && (
        <span className="settings-row__arrow" aria-hidden="true">
          <Icon name="chevron" size={18} />
        </span>
      )}
    </button>
  );
}
