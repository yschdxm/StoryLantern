/**
 * 世界包编辑器（Sheet 内联）的纯表单逻辑。
 *
 * 世界包是**发布单位**，不是卡片：它只有清单字段（名称/版本/作者/许可/语言/标签 + 卡片 ID 列表）。
 * 表单只拥有这些字段；其余字段（以及未来版本新增的未知字段）在保存时原样保留，
 * 避免"在旧客户端编辑一次就把新字段抹掉"。
 */

import { ulid } from '../../../../../packages/oplog/src/index.ts';
import type { WorldPackManifest } from '../../../../../packages/cards/src/index.ts';

export const DEFAULT_PACK_VERSION = '1.0.0';
export const DEFAULT_PACK_LANGUAGE = 'zh-CN';

/** 表单草稿：`tags` 用逗号文本承载（表单值），卡片选择保持**点击顺序**。 */
export interface PackDraft {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  language: string;
  tags: string;
  card_ids: string[];
}

export function emptyPackDraft(): PackDraft {
  return {
    name: '',
    version: DEFAULT_PACK_VERSION,
    description: '',
    author: '',
    license: '',
    language: DEFAULT_PACK_LANGUAGE,
    tags: '',
    card_ids: [],
  };
}

/** 清单 → 草稿（表单能看到、能改的字段才进草稿）。 */
export function draftOfPack(pack: WorldPackManifest): PackDraft {
  return {
    name: pack.name,
    version: pack.version,
    description: pack.description ?? '',
    author: pack.author ?? '',
    license: pack.license ?? '',
    language: pack.language,
    tags: (pack.tags ?? []).join('，'),
    card_ids: [...pack.card_ids],
  };
}

/** 卡片多选：已选则移除；未选则**追加到末尾**（顺序 = 点击顺序，不按字母重排）。 */
export function toggleCard(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
}

/** 去重 + 去空 + 保持首次出现顺序：同一张卡勾两次也只写一次。 */
export function normalizeCardIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const clean = id.trim();
    if (clean === '' || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/** 标签文本 → 数组（中英文逗号、顿号、换行都当分隔）。 */
export function splitTags(text: string): string[] {
  return text
    .split(/[,，、\n]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** 清单里的标签 → 表单文本（与 `splitTags` 互逆）。 */
export function tagsText(tags: readonly string[] | undefined): string {
  return (tags ?? []).join('，');
}

/**
 * 草稿 → 清单。
 *
 * **约定：名称非空由 UI 校验，`buildPack` 不抛错**——空名时仍返回结构完整的清单，
 * 这样界面可以实时预览/提示而不必在纯函数里抛异常（保存按钮由界面禁用）。
 * `existing` 存在时保留 id、created_at 与表单之外的未知字段；表单拥有的可选字段
 * 在草稿里为空时会**删除**（显式清空），而不是悄悄保留旧值。
 */
export function buildPack(existing: WorldPackManifest | undefined, draft: PackDraft, now: number): WorldPackManifest {
  const name = draft.name.trim();
  const version = draft.version.trim() === '' ? DEFAULT_PACK_VERSION : draft.version.trim();
  const language = draft.language.trim() === '' ? DEFAULT_PACK_LANGUAGE : draft.language.trim();
  const description = draft.description.trim();
  const author = draft.author.trim();
  const license = draft.license.trim();
  const tags = splitTags(draft.tags);
  // 先摘掉表单拥有的可选字段，再按草稿是否填写决定加回：空值必须能清掉旧值
  const base: WorldPackManifest = existing ?? {
    schema: 'worldpack/v1',
    id: ulid(),
    name: '',
    version,
    language,
    card_ids: [],
  };
  const { description: _description, author: _author, license: _license, tags: _tags, ...rest } = base;
  return {
    ...rest,
    schema: base.schema,
    id: base.id,
    name,
    version,
    language,
    card_ids: normalizeCardIds(draft.card_ids),
    created_at: base.created_at ?? now,
    updated_at: now,
    ...(description === '' ? {} : { description }),
    ...(author === '' ? {} : { author }),
    ...(license === '' ? {} : { license }),
    ...(tags.length === 0 ? {} : { tags }),
  };
}
