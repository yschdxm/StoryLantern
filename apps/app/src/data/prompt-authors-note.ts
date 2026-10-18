/**
 * 作者注（B18）：自由文本设置 → 独立提示块与 trace。纯函数，没有 UI。
 *
 * - 设置键 `chat.authors_note`（默认空 = 不注入）。
 * - 内容作为独立块 `app.authors_note`（before-history，priority 81：memory 82 之后、summary 80 之前），
 *   纳入 system 预算；空/未设时 trace 里仍可见但 `included:false, reason:'未设置'`。
 * - 作者文本里的 `{{char}}`/`{{user}}` 会展开（与其它卡片作者文本一致）；**用户历史不展开**。
 */

import { expandMacros, type MacroContext } from './macros.ts';
import type { PromptTraceBlockV2 } from './prompt-v2.ts';
import { SETTING_KEYS } from './types.ts';

export const AUTHORS_NOTE_BLOCK_ID = 'app.authors_note';

/** 从设置读作者注；空串 = 未设置（返回 undefined）。 */
export function readAuthorsNote(settings: Record<string, string>): string | undefined {
  const text = (settings[SETTING_KEYS.authorsNote] ?? '').trim();
  return text === '' ? undefined : text;
}

/** 渲染作者注（宏只对作者文本展开）。 */
export function authorsNoteDisplay(note: string | undefined, macros: MacroContext | undefined): string | undefined {
  if (note === undefined) return undefined;
  const expanded = expandMacros(note, macros).trim();
  return expanded === '' ? undefined : expanded;
}

/** 保证 trace 里能看到块：空/未设时补一个 `included:false, reason:'未设置'` 的块。 */
export function ensureAuthorsNoteBlock(
  blocks: readonly PromptTraceBlockV2[],
  note: string | undefined,
): PromptTraceBlockV2[] {
  if (blocks.some((block) => block.id === AUTHORS_NOTE_BLOCK_ID)) return [...blocks];
  return [
    ...blocks,
    {
      id: AUTHORS_NOTE_BLOCK_ID,
      kind: 'authorsNote',
      chars: 0,
      estimatedTokens: 0,
      included: false,
      reason: note === undefined ? '未设置' : '',
    },
  ];
}
