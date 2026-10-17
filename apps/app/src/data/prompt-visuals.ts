import type { VisualAsset } from '../../../../packages/cards/src/index.ts';

/**
 * 视觉设定 → 提示词里的「外观参考」。
 *
 * 纯文本模型读不了图：只有 `caption` 有意义（描述优先；没有 `path` 也能进提示词）。
 * 保持确定性：只按 `visuals` 数组顺序取前 N 条，不排序、不做概率/随机挑选。
 */
export function visualCaptions(
  visuals: readonly VisualAsset[] | undefined,
  limit: number,
  types?: readonly string[],
): string[] {
  const out: string[] = [];
  if (limit <= 0) return out;
  for (const visual of visuals ?? []) {
    if (types !== undefined && !types.includes(visual.type)) continue;
    const caption = (visual.caption ?? '').trim();
    if (caption === '') continue;
    out.push(caption);
    if (out.length >= limit) break;
  }
  return out;
}

/** 有 caption 才追加一行 `${title}${caption1；caption2…}`；一条都没有就整段不出。 */
export function appendVisualCaptions(
  lines: string[],
  visuals: readonly VisualAsset[] | undefined,
  title: string,
  limit: number,
  types?: readonly string[],
): void {
  const captions = visualCaptions(visuals, limit, types);
  if (captions.length > 0) lines.push(`${title}${captions.join('；')}`);
}
