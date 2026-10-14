import { createLocaleService } from '../../../../packages/i18n/src/index.ts';
import type { LocaleService } from '../../../../packages/plugin-api/src/index.ts';
import { APP_MESSAGES, APP_NAMESPACE } from './messages.ts';

/**
 * 应用文案的接入方式（纯逻辑，不含 React，便于 Node 测试）。
 *
 * 优先用内核的 `LocaleService`（组合出来的 locale 插件），这样"语言"只有一处事实源；
 * 组合失败时用 `packages/i18n` 现起一个只带应用目录的服务——界面不该因为插件没起来就变成 key。
 */

export type Translator = (key: string, params?: Record<string, string | number>) => string;

export function registerAppMessages(service: LocaleService): void {
  for (const [locale, messages] of Object.entries(APP_MESSAGES)) {
    service.register({ locale, namespace: APP_NAMESPACE, messages });
  }
}

export function createAppLocaleService(locale?: string): LocaleService {
  const service = createLocaleService(locale === undefined || locale === '' ? {} : { locale });
  registerAppMessages(service);
  return service;
}

/** 把内核的 t 收敛成"只查应用命名空间"的两参函数，界面侧用起来最省事。 */
export function translatorOf(service: LocaleService): Translator {
  return (key, params) => service.t(key, params, { namespace: APP_NAMESPACE });
}
