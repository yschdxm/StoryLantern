import type { LocaleMessages, TranslateParams } from '../../../packages/plugin-api/src/index.ts';
import { interpolate } from '../../../packages/i18n/src/index.ts';

/** 这个插件贡献的语言包命名空间。 */
export const MESSAGE_NAMESPACE = 'writing-pipeline';

/**
 * 块图装配产生的是**用户可见文本**（Request Inspector 里每一块的"为什么纳入/为什么裁掉"），
 * 因此它必须走 locale service，而不是把中文写死在逻辑里。
 */
export const MESSAGES: Record<string, LocaleMessages> = {
  'zh-CN': {
    'pipeline.node.included': '纳入（优先级 {{priority}}，占用 {{tokens}} tokens）',
    'pipeline.node.omitted': '预算不足裁掉（已用 {{used}}/{{budget}}，本块需 {{tokens}}）',
    'pipeline.node.truncated': '块内截断到本块预算 {{budget}} tokens（丢掉 {{dropped}} 字，末尾…；截后 {{tokens}} tokens）',
    'pipeline.node.mustKeep': '必须保留：全局预算 {{used}}/{{budget}} 已满，仍纳入本块（{{tokens}} tokens）',
  },
  en: {
    'pipeline.node.included': 'Included (priority {{priority}}, {{tokens}} tokens)',
    'pipeline.node.omitted': 'Dropped for budget (used {{used}}/{{budget}}, needs {{tokens}})',
    'pipeline.node.truncated': 'Truncated to this block budget of {{budget}} tokens ({{dropped}} chars dropped, ends with …; now {{tokens}} tokens)',
    'pipeline.node.mustKeep': 'Must keep: global budget {{used}}/{{budget}} is full, still included ({{tokens}} tokens)',
  },
};

export type Translator = (key: string, params?: TranslateParams) => string;

/**
 * 无 locale service 时的兜底翻译器。
 * 它保证 `assembleBlocks` 作为纯函数可以独立使用（测试、eval harness、第三方调用），
 * 同时又让"有 locale 时必须走 locale"这条规则在插件层强制执行。
 */
export function fallbackTranslator(locale = 'zh-CN'): Translator {
  const messages = MESSAGES[locale] ?? MESSAGES['zh-CN'] ?? {};
  return (key, params) => {
    const template = messages[key];
    return template === undefined ? key : interpolate(template, params);
  };
}

/** 该插件用到的全部 key（CI 用它做 key 对齐检查）。 */
export function usedKeys(): string[] {
  return Object.keys(MESSAGES['zh-CN'] ?? {}).sort();
}
