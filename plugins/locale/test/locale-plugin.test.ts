import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../../../packages/kernel/src/context.ts';
import { activatePlugin } from '../../../packages/kernel/src/plugin.ts';
import type { LocaleService } from '../../../packages/plugin-api/src/index.ts';
import * as localePlugin from '../src/index.ts';
import { MESSAGES } from '../src/messages.ts';

/** 语言包对齐检查：把复数后缀去掉后，各语言的 key 集合必须一致。 */
function baseKeys(messages: Record<string, string>): string[] {
  return [...new Set(Object.keys(messages).map((key) => key.replace(/\.(one|two|few|many|other|zero)$/, '')))].sort();
}

async function setup(config: Record<string, unknown> = {}): Promise<{ ctx: ReturnType<typeof createContext>; locale: LocaleService }> {
  const ctx = createContext();
  await activatePlugin(ctx, {
    id: 'locale',
    name: '@storylantern/plugin-locale',
    plugin: localePlugin,
    config,
  });
  await ctx.settle();
  return { ctx, locale: ctx.require<LocaleService>('locale') };
}

test('插件注册 locale 服务并内置核心文案', async () => {
  const { ctx, locale } = await setup({ locale: 'zh-CN' });
  assert.equal(locale.locale, 'zh-CN');
  assert.equal(locale.t('app.name'), '叙灯');
  assert.match(locale.t('app.tagline'), /本地优先/);
  assert.deepEqual(locale.missing(), []);
  await ctx.dispose();
});

test('切到英文：同一批 key 出英文，复数按 Intl.PluralRules', async () => {
  const { ctx, locale } = await setup({ locale: 'zh-CN' });
  assert.equal(locale.setLocale('en'), true);
  assert.equal(locale.t('app.name'), 'Story Lantern');
  assert.equal(locale.t('message.count', { count: 1 }), '1 message');
  assert.equal(locale.t('message.count', { count: 3 }), '3 messages');

  locale.setLocale('zh-CN');
  assert.equal(locale.t('message.count', { count: 3 }), '3 条消息');
  await ctx.dispose();
});

test('未配置语言时按系统偏好选择；系统偏好不被支持时退回默认语言', async () => {
  const noConfig = await setup({});
  assert.ok(noConfig.locale.locale.length > 0, '自动探测后必须有具体语言');
  assert.equal(noConfig.locale.supports(noConfig.locale.locale), true);
  await noConfig.ctx.dispose();

  const unsupported = await setup({ locale: 'fr-FR' });
  assert.equal(unsupported.locale.locale, 'fr-FR', '服务记录用户请求的语言');
  assert.equal(unsupported.locale.t('app.name'), '叙灯', 'fr 不支持时按回退链命中 zh-CN');
  await unsupported.ctx.dispose();
});

test('卸载即撤销：上下文销毁后语言包全部消失（注册即 effect）', async () => {
  const { ctx, locale } = await setup({ locale: 'zh-CN' });
  assert.equal(locale.supports('zh-CN'), true);
  await ctx.dispose();
  assert.equal(locale.supports('zh-CN'), false);
  assert.deepEqual(locale.locales(), []);
});

test('语言包 key 对齐：中英文之间只允许复数后缀不同', () => {
  const zh = baseKeys(MESSAGES['zh-CN'] as Record<string, string>);
  const en = baseKeys(MESSAGES['en'] as Record<string, string>);
  assert.deepEqual(en, zh, '新增文案必须两种语言同时补上');
  assert.ok(zh.length >= 10, '核心文案数量应当有下限，避免误删');
});
