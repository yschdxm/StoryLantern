import type { AppMessages } from './messages-types.ts';

/**
 * 中文文案分片：**世界包编辑**（世界包里没有卡片编辑器那么大的表单，但字段与提示不少）。
 *
 * 与 `catalog-zh-world.ts` 同一种分片做法，合并点在 `messages.ts`。
 */
export const zhPack: AppMessages = {
  'pack.new': '新建世界包',
  'pack.edit.title': '编辑世界包：{{name}}',
  'pack.noStore': '当前存储没有世界包仓储，无法读取或保存世界包。',

  'pack.field.name': '名称',
  'pack.field.name.placeholder': '例如：边境城设定集',
  'pack.field.name.required': '世界包名称不能为空。',
  'pack.field.version': '版本',
  'pack.field.description': '描述',
  'pack.field.description.placeholder': '给读者看的一句话简介',
  'pack.field.author': '作者',
  'pack.field.license': '许可',
  'pack.field.language': '语言',
  'pack.field.tags': '标签',
  'pack.field.tags.hint': '用逗号分隔，例如：奇幻，边境，低魔',

  'pack.cards.title': '包含的卡片',
  'pack.cards.hint': '已选 {{count}} 张。包内顺序按勾选顺序保存，不按字母重排。',
  'pack.cards.search': '搜索卡片名称',
  'pack.cards.empty': '还没有可加入的卡片。',
  'pack.cards.noMatch': '没有匹配的卡片。',
  'pack.warning.noCards': '还没有选择卡片：空包可以保存，但导出或挂载时不会带任何内容。',
  'pack.cardType.character': '角色',
  'pack.cardType.scene': '场景',
  'pack.cardType.item': '物品',
  'pack.cardType.lore': '典籍',

  'pack.saveFailed': '保存世界包失败。原因：{{message}}。请检查名称与版本后重试；当前输入还在，可直接再点保存。',
  'pack.delete': '删除世界包',
  'pack.delete.hint': '删除只移除这个包，不会删除包里的卡片。',
  'pack.delete.title': '删除世界包',
  'pack.delete.message': '确定删除「{{name}}」吗？包里的卡片不会被删除，但引用这个包的会话资源池会少掉它们。',
  'pack.deleteFailed': '删除世界包失败。原因：{{message}}。请稍后重试；卡片与包都还在。',
};
