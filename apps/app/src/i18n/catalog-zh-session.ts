import type { AppMessages } from './messages-types.ts';

/**
 * 中文文案分片：**会话创建**（SessionSetup，ADR-0011）。
 * 合并点在 `messages.ts`；主 catalog 已贴 400 行上限，不往里塞。
 */
export const zhSession: AppMessages = {
  // 顶栏标题：main.tsx 用 `t(`tab.${route.name}`)`，路由名是 sessionNew
  'tab.sessionNew': '新建会话',
  'session.create.title': '新建会话',
  'session.create.loading': '正在读取角色与世界资源…',
  'session.create.noCards': '当前存储不支持卡片模型；成员将从旧角色记录读取，资源池暂不可用。',
  'session.create.noPacks': '当前存储没有世界包列表；资源池只能挂载单卡。',
  'session.create.noStore': '当前存储没有「按开局配置建会话」的能力：可能应用版本过旧或被降级。请更新应用后重试；已选内容不会丢失。',
  'session.create.failed': '没能创建会话：{{message}}。可能是存储不可用，或所选成员已被删除。请检查后重试；已选内容不会丢失。',

  'session.create.members': '成员',
  'session.create.members.hint': '至少选择一个角色；选多个就是群聊。',
  'session.create.members.empty': '还没有角色卡；先到「角色」标签创建一个角色。',

  'session.create.basic': '基本信息',
  'session.create.titleLabel': '会话标题',
  'session.create.titleHint': '留空 = 第一个成员的名字。',
  'session.create.titlePlaceholder': '例如：隘口之夜',

  'session.create.situation': '这一局',
  'session.create.premise': '处境 / 切入点',
  'session.create.premiseHint': '建议填写：这一局从哪里开始、用户为什么在这里；留空也能创建。',
  'session.create.premisePlaceholder': '雨夜，你推开边境酒馆的门，炉火将尽。',
  'session.create.userRole': '用户角色',
  'session.create.userRoleHint': '用户在这一局里是谁（可留空）。',
  'session.create.userRolePlaceholder': '路过的旅人',
  'session.create.setting': '时代 / 地点',
  'session.create.settingHint': '例如「低魔中世纪边境」（可留空）。',
  'session.create.settingPlaceholder': '低魔中世纪边境',
  'session.create.tone': '基调',
  'session.create.tone.unset': '不指定',
  'session.create.tone.light': '轻松',
  'session.create.tone.serious': '严肃',
  'session.create.tone.dark': '黑暗',
  'session.create.tone.mystery': '悬疑',

  'session.create.resources': '世界资源',
  'session.create.resources.hint': '不选 = 全库可用（所有卡片都能参与）；选了就只把所选的包与单卡放进本局资源池。',
  'session.create.packs': '世界包',
  'session.create.packs.empty': '还没有世界包；跳过即可。',
  'session.create.cards': '单卡',
  'session.create.cards.search': '搜索资源卡',
  'session.create.cards.searchPlaceholder': '按名字筛选…',
  'session.create.cards.empty': '还没有场景 / 物品 / 典籍卡。',
  'session.create.cards.noMatch': '没有匹配的卡片。',
  'session.create.scene': '当前场景',
  'session.create.scene.free': '自由场景（不指定）',
  'session.create.scene.empty': '还没有场景卡；可以先留空，由处境决定舞台。',

  'session.create.opening': '开场',
  'session.create.opening.hint': '开场属于这一局，不属于角色卡。',
  'session.create.opening.designated': '指定开场',
  'session.create.opening.designated.hint': '选一个成员开口；文本留空就用该角色的开场白草稿首段。',
  'session.create.opening.needMember': '先选择成员，才能指定开口角色。',
  'session.create.opening.speaker': '由谁开口',
  'session.create.opening.input': '开场文本',
  'session.create.opening.inputHint': '留空 = 用该角色的开场白草稿首段',
  'session.create.opening.inputPlaceholder': '「进来吧，风会替你关门。」',
  'session.create.opening.self': '用户开场',
  'session.create.opening.self.hint': '会话从空白开始，你先说第一句。',
  'session.create.opening.auto': '智能开场',
  'session.create.opening.auto.unavailable': '模型生成开场尚未实现',

  'session.create.submit': '开始会话',
  'session.create.submitBusy': '创建中…',
};
