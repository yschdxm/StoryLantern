import type { LocaleMessages } from '../../../packages/plugin-api/src/index.ts';

/**
 * 核心文案。
 *
 * 为什么放在 TS 里而不是 JSON：`key` 与 `params` 都能被类型检查覆盖，且不需要额外的构建步骤；
 * 第三方插件仍然可以直接传普通对象/JSON（`locale.register` 只要求是 `Record<string, string>`）。
 *
 * 复数约定：`key.one` / `key.other` 由 `Intl.PluralRules` 选择。
 * 中文只有 `other`，英文分 `one`/`other`，所以两边的 key 集合天然不完全相同。
 */
export const MESSAGES: Record<string, LocaleMessages> = {
  'zh-CN': {
    'app.name': '叙灯',
    'app.tagline': '本地优先的 AI 角色扮演与创作工作台',

    'common.confirm': '确定',
    'common.cancel': '取消',
    'common.retry': '重试',
    'common.copy': '复制',
    'common.close': '关闭',
    'common.copyFailed': '复制失败：{{reason}}',

    'sync.status.idle': '已同步',
    'sync.status.syncing': '正在同步…',
    'sync.status.offline': '离线（改动已保存在本地）',
    'sync.status.rolledBack': '远端似乎被回滚，本地数据未受影响',
    'sync.conflict.fork': '这条消息在两台设备上都被修改过，请选择一个版本或都保留',
    'sync.gc.waiting': '暂不回收：仍有设备未并入（已确认到第 {{seq}} 段）',

    'pairing.title': '扫码配对',
    'pairing.expired': '配对二维码已过期，请重新生成',
    'pairing.warning': '二维码包含端到端加密密钥，请只在自己的屏幕上使用，不要外发',

    'character.count.other': '{{count}} 个角色',
    'message.count.other': '{{count}} 条消息',
  },
  en: {
    'app.name': 'Story Lantern',
    'app.tagline': 'A local-first AI roleplay and writing workbench',

    'common.confirm': 'Confirm',
    'common.cancel': 'Cancel',
    'common.retry': 'Retry',
    'common.copy': 'Copy',
    'common.close': 'Close',
    'common.copyFailed': 'Copy failed: {{reason}}',

    'sync.status.idle': 'Up to date',
    'sync.status.syncing': 'Syncing…',
    'sync.status.offline': 'Offline (changes are stored locally)',
    'sync.status.rolledBack': 'Remote looks rolled back; local data is untouched',
    'sync.conflict.fork': 'This message was edited on two devices — pick one version or keep both',
    'sync.gc.waiting': 'Not collecting yet: a device has not caught up (confirmed through segment {{seq}})',

    'pairing.title': 'Pair by QR code',
    'pairing.expired': 'This pairing code has expired, please generate a new one',
    'pairing.warning': 'The code contains the end-to-end key. Show it only on your own screen.',

    'character.count.one': '{{count}} character',
    'character.count.other': '{{count}} characters',
    'message.count.one': '{{count}} message',
    'message.count.other': '{{count}} messages',
  },
};

/** 这个插件贡献的语言包命名空间。 */
export const MESSAGE_NAMESPACE = 'core';

export function localeKeys(locale: string): string[] {
  return Object.keys(MESSAGES[locale] ?? {}).sort();
}
