import { defineConfig } from '../../../packages/plugin-api/src/index.ts';
import type { PluginContext } from '../../../packages/plugin-api/src/index.ts';
import { createLocaleService, DEFAULT_FALLBACKS, DEFAULT_LOCALE, detectLocale, systemLocaleHints } from '../../../packages/i18n/src/index.ts';
import { MESSAGES, MESSAGE_NAMESPACE } from './messages.ts';

export const name = 'locale';

export const Config = defineConfig({
  locale: {
    type: 'string',
    default: '',
    description: '界面语言（BCP-47，例如 zh-CN / en）；留空则按系统偏好自动选择',
  },
  fallbacks: {
    type: 'array',
    items: { type: 'string' },
    default: [...DEFAULT_FALLBACKS],
    description: '回退语言链：找不到文案时按顺序往下找',
  },
  strict: {
    type: 'boolean',
    default: false,
    description: '缺翻译时直接报错（开发/CI 用；默认只是记录并显示 key）',
  },
});

/**
 * 提供 `locale` 服务并注册核心文案。
 *
 * 其它插件用 `inject: ['locale']` 拿它——依赖缺失时会保持未激活而不是抛错，
 * 因此一个不带 locale 的极简组合仍然能跑（只是文案回退到默认语言）。
 */
export function apply(ctx: PluginContext, config: Record<string, unknown>): void {
  const configured = typeof config.locale === 'string' ? config.locale.trim() : '';
  const fallbacks = Array.isArray(config.fallbacks)
    ? config.fallbacks.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    : [...DEFAULT_FALLBACKS];

  const detected = configured === '' ? detectLocale(systemLocaleHints(), { supported: Object.keys(MESSAGES), fallbacks }) : configured;

  const service = createLocaleService({
    locale: detected === '' ? DEFAULT_LOCALE : detected,
    fallbacks,
    strict: config.strict === true,
  });

  ctx.set('locale', service);

  for (const [locale, messages] of Object.entries(MESSAGES)) {
    const off = service.register({ namespace: MESSAGE_NAMESPACE, locale, messages });
    ctx.effect(() => off);
  }
}
