/**
 * 卡片模型（`@storylantern/cards`）：四类资源 + 会话层 + 世界包 + 激活规则。
 *
 * 这里只有**类型与纯函数**，没有 I/O、没有 React、没有 op 日志依赖 ——
 * 因此它能在 Node 单测里穷举，也能被界面、宿主、导入器共用。
 */

export * from './types-base.ts';
export * from './types-enums.ts';
export * from './types-character.ts';
export * from './types-world.ts';
export * from './types-session.ts';
export * from './types-document.ts';
export * from './activation.ts';
export * from './expr.ts';
export * from './validate.ts';
export * from './brief.ts';

export type { WorldPackManifest } from './types-world.ts';
