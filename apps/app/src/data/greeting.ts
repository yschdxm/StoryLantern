import type { Character } from './types.ts';

/**
 * 能提供开场白的两种形状：界面用的 `Character` 视图（字段必有）与 op 日志物化出来的
 * `CharacterRecord`（两个字段都是可选的，老角色就没有）。这里只要结构对得上就行。
 */
export interface OpeningSource {
  firstMessage?: string;
  alternateGreetings?: string[];
}

/**
 * 会话开场白的选择。
 *
 * 卡片里的 `alternate_greetings` 以前只存下来、用不上：新建会话一律用第一条。
 * 现在建会话时可以选——`0` 是第一条（默认，与旧行为完全一致），`-1` 表示**不插入开场白**，
 * 其余下标按 `firstMessage` 之后依次对应。
 *
 * 为什么把这段单独拎出来：会话仓储有**两个实现**（内存 / op 日志），
 * 两边必须用同一套规则，否则测试里"同契约"就成了空话。
 */

/** 这台角色可用的开场白列表：第一条是 `firstMessage`，其后是备选；空串一律丢掉。 */
export function openingGreetings(
  character: OpeningSource,
): string[] {
  // 两个字段都可能是 undefined：op 日志物化出来的记录在字段为空时**会省略它**（见 character-projection）
  return [character.firstMessage ?? '', ...(character.alternateGreetings ?? [])]
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 取第 `index` 条开场白。
 *
 * - `undefined` → 第一条（旧行为）；
 * - `-1` → 不插入（干净会话）；
 * - 越界（例如卡片换了、存下来的下标失效）→ 退回第一条，绝不报错；
 * - 一条开场白都没有 → `undefined`（空会话，和旧行为一致）。
 */
export function pickOpening(
  character: OpeningSource,
  index: number | undefined,
): string | undefined {
  if (index === -1) return undefined;
  const greetings = openingGreetings(character);
  if (greetings.length === 0) return undefined;
  return greetings[index ?? 0] ?? greetings[0];
}
