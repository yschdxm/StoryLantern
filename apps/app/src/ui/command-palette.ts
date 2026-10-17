import type { Route } from '../app/router.ts';

/**
 * Ctrl/Cmd+K 命令面板的**纯数据部分**（不 import React，因此可以在无依赖的 Node 测试里跑）。
 *
 * 面板本身只做一件事：把"能去哪"列出来、按输入过滤、回车跳过去。
 * 不塞进"新建会话/删除"这类需要上下文与确认的动作 —— 那些留在各页面自己的菜单里，
 * 免得一个快捷键面板变成第二套会改数据的入口。
 */

export interface PaletteCommand {
  /** 稳定 id（测试与去重都用它）。 */
  id: string;
  /** 显示文案（已翻译）。 */
  label: string;
  /** 次要说明（可选，例如所在分组）。 */
  hint?: string;
  route: Route;
}

/** 过滤：大小写不敏感，匹配 label / id / hint 任一；空查询返回全部（顺序不变）。 */
export function filterCommands(query: string, commands: readonly PaletteCommand[]): PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...commands];
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.id} ${command.hint ?? ''}`.toLowerCase();
    return haystack.includes(needle);
  });
}

/** 键盘选择：返回下一个要选中的下标（循环）。 */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const raw = current + delta;
  return ((raw % length) + length) % length;
}
