import type { AppMessages } from './messages-types.ts';

/**
 * 英文文案的追加分片（与 `catalog-zh-extra.ts` 对称；`catalog-en.ts` 也贴着 400 行上限）。
 * 合并点在 `messages.ts`。
 */
export const enExtra: AppMessages = {
  'palette.label': 'Command palette',
  'palette.placeholder': 'Go to… (↑↓ select, Enter open, Esc close)',
  'palette.empty': 'No matching page',
  'settings.profile.title': 'Shareable profile',
  'settings.profile.hint':
    'Export settings as JSON to share, or paste someone else’s JSON to apply it. No secrets: keys are stripped on export and rejected on import.',
  'settings.profile.generate': 'Generate profile',
  'settings.profile.copy': 'Copy',
  'settings.profile.copied': 'Copied to clipboard',
  'settings.profile.paste': 'Paste profile JSON here',
  'settings.profile.apply': 'Apply pasted profile',
  'settings.profile.applied': 'Applied {count} settings',
  'settings.profile.removed': ' ({count} secret-like settings rejected)',
  // Card model (ADR-0011): block names shown in the request panel
  'chat.trace.block.setup': 'Session setup',
  'chat.trace.block.rules': 'Character rules',
  'chat.trace.block.state': 'Current state',
  'chat.trace.block.scene': 'Current scene',
  'chat.trace.block.items': 'Held items',
  'chat.trace.block.examples': 'Example dialogue',
  'chat.trace.block.summary': 'Relevant summaries',
  'chat.trace.rulesOmitted': '{count} conditional rules skipped (condition evaluator not implemented yet; not pretending they apply)',
  'chat.trace.loreDropped': '{count} lore entries not injected (probability miss or over budget)',
};
