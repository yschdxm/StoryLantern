import type { AppMessages } from './messages-types.ts';

/**
 * 中文文案的**追加分片**（`catalog-zh.ts` 已贴 400 行上限，再往里加会直接超）。
 * 分片是既有做法（`catalog-zh-sync.ts` 同款），合并点在 `messages.ts`。
 */
export const zhExtra: AppMessages = {
  // rerank（交叉编码器）相关
  'settings.vector.rerankModel': '精排用的 rerank 模型（可留空）',
  'settings.vector.rerankModel.hint':
    'rerank 模型是交叉编码器：直接给「问题+文档」打分，和上面的 embedding 模型不是一类。留空 = 不做精排（少一次网络调用）。',
  'settings.vector.testRerank': '测试 rerank',
  'settings.vector.rerankOk': 'rerank 正常：{order}（{ms} ms）',
  // 命令面板
  'palette.label': '命令面板',
  'palette.placeholder': '去哪里…（↑↓ 选择，Enter 进入，Esc 关闭）',
  'palette.empty': '没有匹配的页面',
  // 可分享的配置档
  'settings.profile.title': '配置文件（可分享）',
  'settings.profile.hint':
    '把设置导出成 JSON 发给别人，或把别人给的 JSON 粘回来应用。不含任何密钥：导出时就剔除，导入时也会拒绝。',
  'settings.profile.generate': '生成配置文件',
  'settings.profile.copy': '复制',
  'settings.profile.copied': '已复制到剪贴板',
  'settings.profile.paste': '把配置文件 JSON 粘到这里',
  'settings.profile.apply': '应用粘贴的配置',
  'settings.profile.applied': '已应用 {count} 项设置',
  'settings.profile.removed': '（已拒绝 {count} 个密钥类设置）',
};
