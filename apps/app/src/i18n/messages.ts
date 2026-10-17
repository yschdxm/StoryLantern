import { en } from './catalog-en.ts';
import { zhCN } from './catalog-zh.ts';
import { enSync } from './catalog-en-sync.ts';
import { zhSync } from './catalog-zh-sync.ts';
import { zhRerank } from './catalog-zh-rerank.ts';
import type { AppMessages } from './messages-types.ts';

/**
 * 界面文案目录的入口（命名空间 `app`）。
 *
 * 为什么放在应用里而不是 locale 插件里：这些 key 描述的是**界面结构**，
 * 跟界面的改动同生共死；放一起改，才不会出现"界面改了、翻译忘了"。
 *
 * 中英分成两个文件：单一职责，也避免这个文件无限膨胀（门禁 400 行）。
 */

export const APP_NAMESPACE = 'app';
export const APP_LOCALES = ['zh-CN', 'en'] as const;

export type { AppMessages } from './messages-types.ts';

export const APP_MESSAGES: Record<string, AppMessages> = {
  'zh-CN': { ...zhCN, ...zhSync, ...zhRerank },
  en: { ...en, ...enSync },
};
