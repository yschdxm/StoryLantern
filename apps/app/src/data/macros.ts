/**
 * 作者文本里的宏（**只支持两个**，确定性、无时间/随机）。
 *
 * 为什么只做这两个：它们是角色扮演提示词里真正有语义的上下文占位符——
 * `{{char}}` = 第一个会话成员的名字，`{{user}}` = 这一局用户是谁（`setup.user_role`，空则「你」）。
 * 其它 `{{...}}`（随机、变量、时间…）**原样保留**：不认识的宏宁可让作者看见，也不猜。
 *
 * 纪律：只对**卡片/开局作者文本**展开（character/setup/lore/post-history 等），
 * **不碰聊天历史与用户输入**——用户打的字里出现 `{{char}}` 就应该原样显示。
 */

export interface MacroContext {
  /** 第一个成员角色的名字（没有成员时缺省）。 */
  charName?: string;
  /** 这一局用户是谁（`setup.user_role`，空由展开时回落到「你」）。 */
  userName?: string;
}

const MACRO = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** 展开 `{{char}}` / `{{user}}`；未知宏原样保留。缺省上下文 = 什么都不展开。 */
export function expandMacros(text: string, context: MacroContext = {}): string {
  return text.replace(MACRO, (whole: string, name: string) => {
    if (name === 'char') {
      const value = (context.charName ?? '').trim();
      return value === '' ? whole : value;
    }
    if (name === 'user') {
      const value = (context.userName ?? '').trim();
      return value === '' ? '你' : value;
    }
    return whole;
  });
}
