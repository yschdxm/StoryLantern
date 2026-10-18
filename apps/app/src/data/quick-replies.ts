/**
 * 快捷回复（B14）：纯数据 + 宏展开，不含 UI（入口下一批接）。
 *
 * - 卡片 `quick_replies` 是作者数据；`listQuickReplies` 按**会话激活卡顺序**收集、按 id 去重、
 *   过滤 `enabled === false`（与 `activation.ts` 的资源池顺序一致，不另造注册表）。
 * - `expandQuickReply` 复用 `macros.ts`：只展开 `{{char}}`/`{{user}}`，未知宏原样保留。
 */

import type { CharacterCard, QuickReply } from '../../../../packages/cards/src/index.ts';
import { expandMacros } from './macros.ts';

/** 单条快捷回复的宏展开；变量名保持卡片的 char/user 语义。 */
export function expandQuickReply(text: string, vars: { char?: string; user?: string }): string {
  return expandMacros(text, {
    ...(vars.char === undefined ? {} : { charName: vars.char }),
    ...(vars.user === undefined ? {} : { userName: vars.user }),
  });
}

/** 本次会话可用的快捷回复：按激活卡顺序、同 id 只留第一条、跳过禁用的。 */
export function listQuickReplies(cards: readonly CharacterCard[], sessionCardIds: readonly string[]): QuickReply[] {
  const byId = new Map(cards.map((card) => [card.meta.id, card]));
  const seen = new Set<string>();
  const out: QuickReply[] = [];
  for (const cardId of sessionCardIds) {
    const card = byId.get(cardId);
    if (card === undefined) continue;
    for (const reply of card.quick_replies ?? []) {
      if (
        reply === null ||
        typeof reply !== 'object' ||
        typeof reply.id !== 'string' ||
        reply.id === '' ||
        typeof reply.content !== 'string'
      ) {
        continue;
      }
      if (reply.enabled === false || seen.has(reply.id)) continue;
      seen.add(reply.id);
      out.push(reply);
    }
  }
  return out;
}

/** 解析器从酒馆拿到的原始条目（字段名保持 ST 原名）。 */
export interface StQuickReply {
  id?: unknown;
  label?: unknown;
  name?: unknown;
  message?: unknown;
  content?: unknown;
  enabled?: unknown;
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 酒馆 `quick_replies` → 卡片模型；空内容/非法条目跳过（id 缺失时用序号，确定性）。 */
export function quickRepliesFromSt(list: readonly unknown[]): QuickReply[] {
  const out: QuickReply[] = [];
  list.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const content = textOf(raw['message'] ?? raw['content']).trim();
    if (content === '') return;
    const id = textOf(raw['id']).trim() || `qr-${index + 1}`;
    const name = textOf(raw['label'] ?? raw['name']).trim() || id;
    out.push({ id, name, content, ...(raw['enabled'] === false ? { enabled: false } : {}) });
  });
  return out;
}

/** 卡片模型 → 酒馆 `quick_replies`（导出用；能再被 `quickRepliesFromSt` 读回）。 */
export function quickRepliesToSt(replies: readonly QuickReply[]): StQuickReply[] {
  return replies.map((reply) => ({
    id: reply.id,
    label: reply.name,
    message: reply.content,
    ...(reply.enabled === false ? { enabled: false } : {}),
  }));
}

/** 从卡片 `quick_replies` 里取启用项（不对输入做去重/排序）。 */
export function enabledQuickReplies(card: CharacterCard): QuickReply[] {
  return (card.quick_replies ?? []).filter((reply) => reply.enabled !== false);
}
