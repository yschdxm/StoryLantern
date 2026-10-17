import type { SettingsSection } from '../app/router.ts';
import type { ScreenProps } from '../screens/screen-props.ts';

/** 设置首页与六个分区页共用的 props（由 main.tsx 的 SettingsScreen 一次性传入）。 */
export interface SettingsProps extends ScreenProps {
  plugins: Array<{ id: string; status: string }>;
  locales: string[];
  onLocaleChange(locale: string): void;
}

/** 分区页的标题 key（同时用于面包屑、详情页返回文案与搜索分组）。 */
export const SETTINGS_SECTION_LABEL: Record<SettingsSection, string> = {
  model: 'settings.section.model',
  appearance: 'settings.section.appearance',
  sync: 'settings.section.sync',
  data: 'settings.section.data',
  advanced: 'settings.section.advanced',
  about: 'settings.section.about',
};
