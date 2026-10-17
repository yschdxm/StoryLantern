import type { AppMessages } from './messages-types.ts';

/**
 * 设置页（三级分层）相关的中文文案。
 *
 * 为什么单独分片：`catalog-zh.ts` 已经 399 行，贴着 400 行门禁；
 * 设置页新增的面包屑/首页/分区行/关于文案放这里合并（见 messages.ts）。
 */
export const zhSettings: AppMessages = {
  // 层级与导航
  'settings.section.home': '设置',
  // 输入示例（URL/模型名是数据，不是界面说明）
  'settings.model.baseUrl.placeholder': 'https://api.deepseek.com/v1',
  'settings.model.apiKey.placeholder': 'sk-…',
  'settings.model.name.placeholder': 'deepseek-chat',
  'settings.section.model': '模型与密钥',
  'settings.section.appearance': '外观与语言',
  'settings.section.sync': '同步与设备',
  'settings.section.data': '数据与备份',
  'settings.section.advanced': '高级与开发者',
  'settings.section.about': '关于',
  'settings.breadcrumb.label': '设置层级',
  'settings.detail.back': '返回{{section}}',

  // 首页：搜索与当前值
  'settings.home.searchPlaceholder': '搜索设置',
  'settings.home.searchLabel': '搜索设置项',
  'settings.home.searchEmpty': '没有匹配的设置项',
  'settings.home.unset': '未配置',
  'settings.home.modelValue': '{{model}} · {{key}}',
  'settings.home.keySet': '密钥已配置',
  'settings.home.keyUnset': '密钥未配置',
  'settings.home.appearanceValue': '{{theme}} · {{font}} · {{locale}}',
  'settings.home.syncOff': '关闭同步',
  'settings.home.syncValue': '{{kind}} · {{time}}',
  'settings.home.dataValue': '{{sessions}} · {{characters}} · {{store}}',
  'settings.home.profiles.one': '{{count}} 个配置',
  'settings.home.profiles.other': '{{count}} 个配置',
  'settings.home.plugins.one': '{{count}} 个插件',
  'settings.home.plugins.other': '{{count}} 个插件',
  'settings.home.aboutValue': '{{version}} · {{license}}',

  // 语言名：专有名词不变，但不再写在组件里
  'settings.lang.zh': '简体中文',
  'settings.lang.en': 'English',

  // 同步方式的短标签（长标签留给分区页选择器）
  'settings.sync.short.off': '关闭',
  'settings.sync.short.webdav': 'WebDAV',
  'settings.sync.short.folder': '本地文件夹',
  'settings.sync.short.s3': 'S3',

  // 当前值/状态（次级文字只说"现在是什么"）
  'settings.value.secretSet': '已设置',
  'settings.value.secretUnset': '未设置',
  'settings.value.manage': '管理',
  'settings.value.pairing': '生成 / 应用链接',
  'settings.value.backup': '导出 / 恢复',
  'settings.value.profile': '导出 / 导入',
  'settings.value.import': '跳到导入页',
  'settings.value.tuner': '查看建议',
  'settings.value.developer': '宿主诊断 / op 日志',
  'settings.value.configured': '已配置',
  'settings.value.connectionNeeded': '待配置',

  // L2 行标题
  'settings.row.chatModel': '聊天模型',
  'settings.row.modelProfiles': '多模型路由',
  'settings.row.connection': '连接配置',
  'settings.row.devices': '设备与密钥环',
  'settings.row.pairing': '配对新设备',
  'settings.row.run': '立即同步',
  'settings.row.backup': '整体备份',
  'settings.row.profile': '配置文件',
  'settings.row.localData': '本地数据',
  'settings.row.tuner': '调优助手',
  'settings.row.version': '版本',
  'settings.row.build': '构建时间',
  'settings.row.license': '许可证',

  // 关于
  'settings.about.versionValue': 'v0.1',
  'settings.about.licenseValue': 'AGPL-3.0-or-later',
  'settings.about.note': 'Story Lantern · 本地优先的 AI 角色扮演与创作工作台。数据存在本机；同步只上传加密后的内容。',

  // 搜索关键词（匹配行标题/当前值之外的俗称与英文词）
  'settings.search.keywords.model': '模型 密钥 接口 服务商 向量 重排 用量 预算 openai deepseek api key model provider embedding rerank usage',
  'settings.search.keywords.appearance': '外观 主题 深色 浅色 字号 语言 theme font language',
  'settings.search.keywords.sync': '同步 备份 webdav s3 文件夹 设备 配对 口令 sync device pair',
  'settings.search.keywords.data': '数据 备份 导入 配置文件 会话 角色 data backup import profile',
  'settings.search.keywords.advanced': '高级 开发者 调优 插件 诊断 op 日志 developer tuner plugin',
  'settings.search.keywords.about': '关于 版本 构建 许可证 about version build license',
};
