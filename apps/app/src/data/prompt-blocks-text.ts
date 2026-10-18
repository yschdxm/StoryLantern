/**
 * 块渲染的文本小工具（从 `prompt-blocks-v2.ts` 抽出，避免它撞 400 行门禁）。
 * 纯函数、零依赖，角色/场景/物品/状态块共用。
 */

export function trimmed(value: string | undefined): string {
  return (value ?? '').trim();
}

export function labeled(label: string, value: string | undefined): string {
  const text = trimmed(value);
  return text === '' ? '' : `${label}：${text}`;
}

export function joinParts(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join('；');
}

export function pushText(lines: string[], label: string, value: string | undefined): void {
  const text = trimmed(value);
  if (text !== '') lines.push(`【${label}】${text}`);
}

export function pushList(lines: string[], label: string, values: readonly string[] | undefined): void {
  const text = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value !== '')
    .join('、');
  if (text !== '') lines.push(`【${label}】${text}`);
}
