/**
 * 视觉设定（`VisualAsset`）的**纯表单逻辑**：卡片 ↔ 编辑器草稿。
 *
 * 资产二进制通道还没接线，所以这一层只做「描述优先」的元数据：
 *  - `caption` 必填（LLM 唯一入口）；
 *  - `path` 可选，有图时才写 `asset://<sha256>`；
 *  - 表单不编辑的字段（`variant_of` 及未来扩展）通过 `raw` 原样保留；
 *  - 顺序按数组原样保持；`is_primary` 全局至多一个（第一个 true 生效）。
 */

import type { VisualAsset } from '../../../../packages/cards/src/index.ts';
import { ulid } from '../../../../packages/oplog/src/index.ts';

/** 设计文档 2.5 列出的常用类型（开放字符串：别的值原样保留）。 */
export const VISUAL_TYPES = [
  'key_art',
  'portrait',
  'turnaround',
  'outfit',
  'detail',
  'palette',
  'expression_sheet',
  'concept',
  'background',
  'icon',
] as const;

export const VISUAL_VIEWS = ['front', 'side', 'back', 'detail'] as const;
export type VisualView = (typeof VISUAL_VIEWS)[number];

export interface VisualDraft {
  id: string;
  /** 开放字符串；界面给常用类型下拉。 */
  type: string;
  /** 必填：纯文本模型读不了图。 */
  caption: string;
  /** 可选：有图时是 `asset://<sha256>`。 */
  path: string;
  /** 逗号分隔 → `tags`。 */
  tags: string;
  view: VisualView | '';
  binding: string;
  /** → `render_prompt` */
  renderPrompt: string;
  isPrimary: boolean;
  notes: string;
  /** 原卡条目：保留表单不编辑的字段（如 `variant_of` / 未来扩展）。 */
  raw?: VisualAsset;
}

function splitTags(text: string): string[] {
  return [...new Set(text.split(/[,，、]/).map((item) => item.trim()).filter((item) => item !== ''))];
}

export function emptyVisualDraft(type = 'key_art'): VisualDraft {
  return {
    id: ulid(),
    type,
    caption: '',
    path: '',
    tags: '',
    view: '',
    binding: '',
    renderPrompt: '',
    isPrimary: false,
    notes: '',
  };
}

/** 卡片 → 草稿：顺序保持，未知字段挂到 `raw`。 */
export function visualsToDrafts(visuals: readonly VisualAsset[] | undefined): VisualDraft[] {
  return (visuals ?? []).map((visual) => ({
    id: visual.id,
    type: visual.type,
    caption: visual.caption,
    path: visual.path ?? '',
    tags: (visual.tags ?? []).join(', '),
    view: visual.view ?? '',
    binding: visual.binding ?? '',
    renderPrompt: visual.render_prompt ?? '',
    isPrimary: visual.is_primary === true,
    notes: visual.notes ?? '',
    raw: visual,
  }));
}

/** 草稿 → 卡片：清空的可选字段会删除旧值；`is_primary` 只保留第一个。 */
export function draftsToVisuals(drafts: readonly VisualDraft[]): VisualAsset[] {
  let primaryTaken = false;
  return drafts.map((draft) => {
    const next: Record<string, unknown> = { ...(draft.raw ?? {}) };
    next['id'] = draft.id;
    next['type'] = draft.type.trim() === '' ? 'key_art' : draft.type.trim();
    next['caption'] = draft.caption;

    const path = draft.path.trim();
    if (path === '') delete next['path'];
    else next['path'] = path;

    const tags = splitTags(draft.tags);
    if (tags.length === 0) delete next['tags'];
    else next['tags'] = tags;

    if (draft.view === '') delete next['view'];
    else next['view'] = draft.view;

    const binding = draft.binding.trim();
    if (binding === '') delete next['binding'];
    else next['binding'] = binding;

    const renderPrompt = draft.renderPrompt.trim();
    if (renderPrompt === '') delete next['render_prompt'];
    else next['render_prompt'] = renderPrompt;

    const notes = draft.notes.trim();
    if (notes === '') delete next['notes'];
    else next['notes'] = notes;

    const primary = draft.isPrimary && !primaryTaken;
    if (primary) {
      primaryTaken = true;
      next['is_primary'] = true;
    } else {
      delete next['is_primary'];
    }
    return next as unknown as VisualAsset;
  });
}

/** UI 的单选主视觉：勾选一项时其余置 false；取消勾选则全部 false。 */
export function withPrimary(drafts: readonly VisualDraft[], id: string, primary: boolean): VisualDraft[] {
  return drafts.map((draft) => ({
    ...draft,
    isPrimary: primary ? draft.id === id : false,
  }));
}
