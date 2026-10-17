import type { AppMessages } from './messages-types.ts';

/**
 * Settings IA (L1 → L2 → L3) copy, split out of `catalog-en.ts`
 * for the same reason as the Chinese shard: keep every catalog file well under 400 lines.
 */
export const enSettings: AppMessages = {
  // Hierarchy & navigation
  'settings.section.home': 'Settings',
  // Input examples (URLs/model names are data, not UI prose)
  'settings.model.baseUrl.placeholder': 'https://api.deepseek.com/v1',
  'settings.model.apiKey.placeholder': 'sk-…',
  'settings.model.name.placeholder': 'deepseek-chat',
  'settings.section.model': 'Model & keys',
  'settings.section.appearance': 'Appearance & language',
  'settings.section.sync': 'Sync & devices',
  'settings.section.data': 'Data & backup',
  'settings.section.advanced': 'Advanced & developer',
  'settings.section.about': 'About',
  'settings.breadcrumb.label': 'Settings hierarchy',
  'settings.detail.back': 'Back to {{section}}',

  // Home: search & current values
  'settings.home.searchPlaceholder': 'Search settings',
  'settings.home.searchLabel': 'Search settings',
  'settings.home.searchEmpty': 'No matching settings',
  'settings.home.unset': 'Not configured',
  'settings.home.modelValue': '{{model}} · {{key}}',
  'settings.home.keySet': 'key configured',
  'settings.home.keyUnset': 'key not set',
  'settings.home.appearanceValue': '{{theme}} · {{font}} · {{locale}}',
  'settings.home.syncOff': 'Sync off',
  'settings.home.syncValue': '{{kind}} · {{time}}',
  'settings.home.dataValue': '{{sessions}} · {{characters}} · {{store}}',
  'settings.home.profiles.one': '{{count}} profile',
  'settings.home.profiles.other': '{{count}} profiles',
  'settings.home.plugins.one': '{{count}} plugin',
  'settings.home.plugins.other': '{{count}} plugins',
  'settings.home.aboutValue': '{{version}} · {{license}}',

  // Language names (proper nouns, but still routed through the catalog)
  'settings.lang.zh': '简体中文',
  'settings.lang.en': 'English',

  // Short sync-method labels for list rows (full labels stay in the picker)
  'settings.sync.short.off': 'Off',
  'settings.sync.short.webdav': 'WebDAV',
  'settings.sync.short.folder': 'Local folder',
  'settings.sync.short.s3': 'S3',

  // Current value / status (secondary text says what is, not what it does)
  'settings.value.secretSet': 'Set',
  'settings.value.secretUnset': 'Not set',
  'settings.value.manage': 'Manage',
  'settings.value.pairing': 'Create / apply link',
  'settings.value.backup': 'Export / restore',
  'settings.value.profile': 'Export / import',
  'settings.value.import': 'Open the import page',
  'settings.value.tuner': 'View suggestions',
  'settings.value.developer': 'Host diagnostics / op log',
  'settings.value.configured': 'Configured',
  'settings.value.connectionNeeded': 'Needs setup',

  // L2 row labels
  'settings.row.chatModel': 'Chat model',
  'settings.row.modelProfiles': 'Model routing',
  'settings.row.connection': 'Connection',
  'settings.row.devices': 'Devices & keyring',
  'settings.row.pairing': 'Pair a new device',
  'settings.row.run': 'Sync now',
  'settings.row.backup': 'Full backup',
  'settings.row.profile': 'Profile file',
  'settings.row.localData': 'Local data',
  'settings.row.tuner': 'Tuning assistant',
  'settings.row.version': 'Version',
  'settings.row.build': 'Build',
  'settings.row.license': 'License',

  // About
  'settings.about.versionValue': 'v0.1',
  'settings.about.licenseValue': 'AGPL-3.0-or-later',
  'settings.about.note': 'Story Lantern · a local-first workbench for AI role-play and writing. Data stays on this device; sync uploads encrypted content only.',

  // Search keywords (common terms beyond row labels and current values)
  'settings.search.keywords.model': 'model key api provider openai deepseek embedding rerank usage cost',
  'settings.search.keywords.appearance': 'appearance theme dark light font size language locale',
  'settings.search.keywords.sync': 'sync webdav s3 folder device pair passphrase backup',
  'settings.search.keywords.data': 'data backup import profile sessions characters local',
  'settings.search.keywords.advanced': 'advanced developer tuner plugin diagnostics op log host',
  'settings.search.keywords.about': 'about version build license agpl',
};
