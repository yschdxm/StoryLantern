import type { AppMessages } from './messages-types.ts';

/**
 * 中文文案的**第二个分片**：rerank 模型相关的几条。
 *
 * 为什么单独开一个文件：`catalog-zh.ts` 已经贴着门禁的 400 行上限 —— 加入这几条会直接超。
 * 分片是既有做法（`catalog-zh-sync.ts` 也这么来），合并点在 `messages.ts`。
 */
export const zhRerank: AppMessages = {
  'settings.vector.rerankModel': '精排用的 rerank 模型（可留空）',
  'settings.vector.rerankModel.hint':
    'rerank 模型是交叉编码器：直接给「问题+文档」打分，和上面的 embedding 模型不是一类。留空 = 不做精排（少一次网络调用）。',
  'settings.vector.testRerank': '测试 rerank',
  'settings.vector.rerankOk': 'rerank 正常：{order}（{ms} ms）',
};
