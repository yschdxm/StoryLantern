/**
 * 卡片校验器（手写、零依赖、不抛异常）。
 *
 * 语义（`docs/specs/世界资源设计文档.md` 第 2、9 章；角色卡文档第 15 章）：
 *  - `error` = 数据不可用：结构坏了、必填字段缺了、资产引用不是 `asset://<sha256>`。
 *  - `warning` = 可以保存，但要提示作者：数量建议、待补全边界、悬空引用、氛围/稀有度缺失。
 *  - 输入是 `unknown`：先收窄再取字段，一处坏了继续收集其它问题；`path` 是点号路径，
 *    根对象用空字符串（`identity.name` / `visuals[0].path`）。
 */

import { CARD_SCHEMA, PACK_SCHEMA, isAssetRef, isKnownCardType, type CardType } from './types-base.ts';

export type IssueSeverity = 'error' | 'warning';

export interface CardIssue { path: string; severity: IssueSeverity; code: string; message: string }

export interface CardValidation { ok: boolean; issues: CardIssue[] }

export interface ValidateOptions { known_card_ids?: ReadonlySet<string> }

const RATINGS: readonly string[] = ['general', 'teen', 'mature'];
const SCENE_KINDS: readonly string[] = ['physical', 'abstract', 'vehicle', 'dimension'];
const ITEM_KINDS: readonly string[] = ['weapon', 'armor', 'consumable', 'quest', 'tool', 'clothing', 'accessory', 'vehicle', 'key_item', 'material', 'other'];
const LORE_KINDS: readonly string[] = ['rule', 'history', 'faction', 'race', 'culture', 'geography', 'tech', 'other'];
const VAR_TYPES: readonly string[] = ['integer', 'string', 'boolean', 'array'];

// ---------------------------------------------------------------- 基础工具

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非空字符串（空白串视同未填）：返回原串，不 trim，避免悄悄改作者数据。 */
function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function typeName(value: unknown): string {
  if (value === undefined) return '未提供';
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value === 'string' ? `字符串「${value}」` : `值（${typeof value}）`;
}

function err(issues: CardIssue[], path: string, code: string, message: string): void {
  issues.push({ path, severity: 'error', code, message });
}

function warn(issues: CardIssue[], path: string, code: string, message: string): void {
  issues.push({ path, severity: 'warning', code, message });
}

function result(issues: CardIssue[]): CardValidation {
  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

function obj(issues: CardIssue[], holder: Record<string, unknown>, key: string, path: string, label: string): Record<string, unknown> | undefined {
  const raw = holder[key];
  if (raw === undefined) { err(issues, path, 'missing-field', `${label} 必填（对象）`); return undefined; }
  if (!isRecord(raw)) { err(issues, path, 'invalid-type', `${label} 必须是对象，收到 ${typeName(raw)}`); return undefined; }
  return raw;
}

function needText(issues: CardIssue[], holder: Record<string, unknown>, key: string, path: string, label: string): string | undefined {
  const raw = holder[key];
  if (raw === undefined) { err(issues, path, 'missing-field', `${label} 必填（非空字符串）`); return undefined; }
  if (typeof raw !== 'string') { err(issues, path, 'invalid-type', `${label} 必须是字符串，收到 ${typeName(raw)}`); return undefined; }
  if (!raw.trim()) { err(issues, path, 'empty-field', `${label} 不能是空字符串`); return undefined; }
  return raw;
}

function needEnum(issues: CardIssue[], holder: Record<string, unknown>, key: string, path: string, allowed: readonly string[], label: string): string | undefined {
  const raw = holder[key];
  const hint = `可选值 ${allowed.join(' / ')}`;
  if (raw === undefined) { err(issues, path, 'missing-field', `${label} 必填（${hint}）`); return undefined; }
  if (typeof raw !== 'string' || !raw.trim()) { err(issues, path, 'invalid-value', `${label} 必须是非空字符串（${hint}），收到 ${typeName(raw)}`); return undefined; }
  if (!allowed.includes(raw)) { err(issues, path, 'invalid-value', `${label} 取值非法：${raw}（${hint}）`); return undefined; }
  return raw;
}

function listAt(issues: CardIssue[], holder: Record<string, unknown>, key: string, path: string, label: string, required: boolean): unknown[] | undefined {
  const raw = holder[key];
  if (raw === undefined) {
    if (required) err(issues, path, 'missing-field', `${label} 必填（数组）`);
    return undefined;
  }
  if (!Array.isArray(raw)) { err(issues, path, 'invalid-type', `${label} 必须是数组，收到 ${typeName(raw)}`); return undefined; }
  return raw;
}

/** 引用字段：结构上必须是非空字符串；给了已知集合时，目标不存在只报 warning（世界包可分批导入）。 */
function refTarget(issues: CardIssue[], holder: Record<string, unknown>, key: string, path: string, known: ReadonlySet<string> | undefined, label: string): void {
  const target = needText(issues, holder, key, path, label);
  if (target !== undefined && known !== undefined && !known.has(target)) {
    warn(issues, path, 'dangling-ref', `${label}「${target}」在已知卡片中不存在（警告，不拦保存）`);
  }
}

// ---------------------------------------------------------------- 基座

function validateVisuals(card: Record<string, unknown>, issues: CardIssue[]): void {
  const raw = card['visuals'];
  if (raw === undefined) return;
  if (!Array.isArray(raw)) { err(issues, 'visuals', 'invalid-type', `visuals 必须是数组，收到 ${typeName(raw)}`); return; }
  let primaryCount = 0;
  raw.forEach((item, index) => {
    const path = `visuals[${index}]`;
    if (!isRecord(item)) { err(issues, path, 'invalid-type', '视觉资产必须是对象'); return; }
    needText(issues, item, 'id', `${path}.id`, '视觉资产 id');
    needText(issues, item, 'type', `${path}.type`, '视觉资产 type');
    const asset = item['path'];
    if (asset === undefined) err(issues, `${path}.path`, 'missing-field', '视觉资产 path 必填');
    else if (typeof asset !== 'string' || !asset.trim()) err(issues, `${path}.path`, 'empty-field', '视觉资产 path 不能是空字符串');
    else if (!isAssetRef(asset)) err(issues, `${path}.path`, 'asset-ref-invalid', 'path 必须是 asset://<sha256>（卡内不内嵌二进制，绝对路径跨设备必坏）');
    if (textOf(item['caption']) === undefined) {
      err(issues, `${path}.caption`, 'visual-caption-missing', 'caption 必填：纯文本模型读不了图，caption 是 LLM 唯一入口');
    }
    if (item['is_primary'] === true) primaryCount += 1;
  });
  if (primaryCount > 1) warn(issues, 'visuals', 'visual-primary-multiple', `有 ${primaryCount} 项 is_primary，至多一项为主视觉`);
}

function validateRefs(card: Record<string, unknown>, issues: CardIssue[], known: ReadonlySet<string> | undefined): void {
  const raw = listAt(issues, card, 'refs', 'refs', 'refs', false);
  raw?.forEach((ref, index) => {
    const path = `refs[${index}]`;
    if (!isRecord(ref)) { err(issues, path, 'invalid-type', '引用必须是对象'); return; }
    refTarget(issues, ref, 'target', `${path}.target`, known, '引用目标');
  });
}

function validateBase(card: Record<string, unknown>, issues: CardIssue[], known: ReadonlySet<string> | undefined): CardType | undefined {
  let cardType: CardType | undefined;
  const rawType = card['card_type'];
  if (!isKnownCardType(rawType)) err(issues, 'card_type', 'card-type-invalid', `card_type 必须是 character / scene / item / lore，收到 ${typeName(rawType)}`);
  else cardType = rawType;

  const meta = obj(issues, card, 'meta', 'meta', 'meta 元信息');
  if (meta) {
    const schema = needText(issues, meta, 'schema', 'meta.schema', 'meta.schema');
    for (const key of ['id', 'name', 'version', 'language', 'description']) needText(issues, meta, key, `meta.${key}`, `meta.${key}`);
    const rating = meta['rating'];
    if (rating === undefined) err(issues, 'meta.rating', 'missing-field', 'meta.rating 必填（general / teen / mature）');
    else if (typeof rating !== 'string' || !RATINGS.includes(rating)) err(issues, 'meta.rating', 'invalid-value', `meta.rating 取值非法：${typeName(rating)}（可选 general / teen / mature）`);
    if (cardType !== undefined && schema !== undefined && schema !== CARD_SCHEMA[cardType]) {
      err(issues, 'meta.schema', 'schema-mismatch', `meta.schema 必须等于 ${CARD_SCHEMA[cardType]}（${cardType} 卡的结构版本）`);
    }
    // 封面也必须是内容寻址的资产引用：绝对路径跨设备必坏（与 visuals[].path 同一条理由）
    const cover = meta['cover'];
    if (cover !== undefined) {
      if (typeof cover !== 'string' || !isAssetRef(cover)) {
        err(issues, 'meta.cover', 'asset-ref-invalid', 'meta.cover 必须是 asset://<sha256>（不能是本机路径）');
      }
    }
  }
  validateVisuals(card, issues);
  validateRefs(card, issues, known);
  return cardType;
}

// ---------------------------------------------------------------- 角色卡

function boundaryField(issues: CardIssue[], persona: Record<string, unknown>, key: string, path: string): void {
  const raw = persona[key];
  if (raw === undefined) { err(issues, path, 'missing-field', '防幻觉边界字段必填（导入的旧卡可先留空后补）'); return; }
  if (typeof raw !== 'string') { err(issues, path, 'invalid-type', `边界字段必须是字符串，收到 ${typeName(raw)}`); return; }
  if (!raw.trim()) warn(issues, path, 'boundary-pending', '空字符串视为「待补全」：保存不拦，导入后请补全（Agent 也可补）');
}

function exampleWarnings(card: Record<string, unknown>, issues: CardIssue[]): void {
  const raw = card['examples'];
  if (raw === undefined) {
    warn(issues, 'examples', 'examples-too-few', '示例对话为空，建议至少 3 组（冷启动 / 冲突 / 日常）');
    warn(issues, 'examples', 'cold-start-example-missing', '缺少冷启动示例：建议有一组 tags 含 cold_start 或 初次');
    return;
  }
  if (!Array.isArray(raw)) { err(issues, 'examples', 'invalid-type', `examples 必须是数组，收到 ${typeName(raw)}`); return; }
  if (raw.length < 3) warn(issues, 'examples', 'examples-too-few', `示例对话只有 ${raw.length} 组，建议至少 3 组`);
  const hasColdStart = raw.filter(isRecord).some((group) => {
    const tags = group['tags'];
    return Array.isArray(tags) && tags.some((tag) => typeof tag === 'string' && (/^cold[_-]?start$/i.test(tag.trim()) || tag.includes('初次')));
  });
  if (!hasColdStart) warn(issues, 'examples', 'cold-start-example-missing', '缺少冷启动示例：建议有一组 tags 含 cold_start 或 初次');
}

function matchesStateType(type: string, value: unknown): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function stateDefaultWarnings(issues: CardIssue[], definition: Record<string, unknown>, type: string, path: string): void {
  const at = `${path}.default`;
  const value = definition['default'];
  if (value === undefined) { warn(issues, at, 'state-default-mismatch', '变量缺少 default：会话初始化时没有初值'); return; }
  if (!matchesStateType(type, value)) { warn(issues, at, 'state-default-mismatch', `default 与 type=${type} 不匹配，运行时该变量不可用`); return; }
  const min = definition['min'];
  const max = definition['max'];
  if (typeof value === 'number' && typeof min === 'number' && value < min) warn(issues, at, 'state-default-out-of-range', `default=${value} 小于 min=${min}`);
  if (typeof value === 'number' && typeof max === 'number' && value > max) warn(issues, at, 'state-default-out-of-range', `default=${value} 大于 max=${max}`);
  const allowed = definition['enum'];
  if (Array.isArray(allowed) && !allowed.some((item) => (Array.isArray(item) && Array.isArray(value)
    ? item.length === value.length && item.every((entry, index) => entry === value[index])
    : item === value))) {
    warn(issues, at, 'state-default-not-in-enum', 'default 不在 enum 允许值里');
  }
}

function stateWarnings(card: Record<string, unknown>, issues: CardIssue[]): void {
  const state = card['state'];
  if (state === undefined) return;
  if (!isRecord(state)) { err(issues, 'state', 'invalid-type', `state 必须是对象，收到 ${typeName(state)}`); return; }
  const schema = state['schema'];
  if (!isRecord(schema)) {
    err(issues, 'state.schema', schema === undefined ? 'missing-field' : 'invalid-type', 'state.schema 必填（变量定义表，对象）');
    return;
  }
  for (const name of Object.keys(schema).sort()) {
    const path = `state.schema.${name}`;
    const definition = schema[name];
    if (!isRecord(definition)) { err(issues, path, 'invalid-type', '变量定义必须是对象'); continue; }
    const type = definition['type'];
    if (typeof type !== 'string' || !VAR_TYPES.includes(type)) { err(issues, `${path}.type`, 'invalid-type', '变量 type 必须是 integer / string / boolean / array'); continue; }
    stateDefaultWarnings(issues, definition, type, path);
  }
}

function validateCharacter(card: Record<string, unknown>, issues: CardIssue[]): void {
  const identity = obj(issues, card, 'identity', 'identity', 'identity 角色定义');
  if (identity) {
    needText(issues, identity, 'name', 'identity.name', 'identity.name');
    needText(issues, identity, 'background', 'identity.background', 'identity.background');
  }
  const persona = obj(issues, card, 'persona', 'persona', 'persona 人格策略');
  if (persona) {
    needText(issues, persona, 'summary', 'persona.summary', 'persona.summary');
    const traits = listAt(issues, persona, 'traits', 'persona.traits', 'persona.traits', true);
    if (traits && traits.length === 0) err(issues, 'persona.traits', 'empty-field', 'persona.traits 必须是非空数组（性格标签）');
    boundaryField(issues, persona, 'knowledge_boundary', 'persona.knowledge_boundary');
    boundaryField(issues, persona, 'ability_boundary', 'persona.ability_boundary');
  }
  const speech = obj(issues, card, 'speech', 'speech', 'speech 语言风格');
  if (speech) {
    needText(issues, speech, 'style', 'speech.style', 'speech.style');
    const lines = speech['example_lines'];
    if (lines === undefined) warn(issues, 'speech.example_lines', 'example-lines-too-few', '示例台词为空，建议至少 5 条并覆盖不同情绪档位');
    else if (!Array.isArray(lines)) err(issues, 'speech.example_lines', 'invalid-type', `speech.example_lines 必须是数组，收到 ${typeName(lines)}`);
    else if (lines.length < 5) warn(issues, 'speech.example_lines', 'example-lines-too-few', `示例台词只有 ${lines.length} 条，建议至少 5 条并覆盖不同情绪档位`);
  }
  exampleWarnings(card, issues);
  stateWarnings(card, issues);
}

// ---------------------------------------------------------------- 世界资源

function validateRefList(card: Record<string, unknown>, issues: CardIssue[], key: string, itemKey: string, label: string, known: ReadonlySet<string> | undefined): void {
  const list = listAt(issues, card, key, key, key, false);
  list?.forEach((item, index) => {
    const path = `${key}[${index}]`;
    if (!isRecord(item)) { err(issues, path, 'invalid-type', `${label}必须是对象`); return; }
    refTarget(issues, item, itemKey, `${path}.${itemKey}`, known, label);
  });
}

function validateScene(card: Record<string, unknown>, issues: CardIssue[], known: ReadonlySet<string> | undefined): void {
  needEnum(issues, card, 'type', 'type', SCENE_KINDS, '场景 type');
  needText(issues, card, 'description', 'description', '场景 description');

  const atmosphere = card['atmosphere'];
  if (atmosphere === undefined) warn(issues, 'atmosphere', 'atmosphere-missing', '缺少 atmosphere：局部更新氛围（下雨只改 sound/smell）会退化为整段重写');
  else if (!isRecord(atmosphere)) err(issues, 'atmosphere', 'invalid-type', `atmosphere 必须是对象，收到 ${typeName(atmosphere)}`);

  let connectionCount = 0;
  const connections = listAt(issues, card, 'connections', 'connections', 'connections', false);
  if (connections) {
    connectionCount = connections.length;
    if (connectionCount === 0) warn(issues, 'connections', 'connections-empty', 'connections 为空：场景跳转只能靠模型瞎编');
    connections.forEach((connection, index) => {
      const path = `connections[${index}]`;
      if (!isRecord(connection)) { err(issues, path, 'invalid-type', '连接必须是对象'); return; }
      refTarget(issues, connection, 'target', `${path}.target`, known, '目标场景 ID');
    });
  } else if (card['connections'] === undefined) {
    warn(issues, 'connections', 'connections-empty', '缺少 connections：场景跳转只能靠模型瞎编');
  }
  if (card['is_entry'] === true && connectionCount === 0) {
    warn(issues, 'is_entry', 'entry-scene-no-connections', '入口场景没有任何连接：开局后会无路可走');
  }
  validateRefList(card, issues, 'occupants', 'target', '角色 ID', known);
  validateRefList(card, issues, 'props', 'item_id', '物品 ID', known);
}

function validateItem(card: Record<string, unknown>, issues: CardIssue[]): void {
  needEnum(issues, card, 'type', 'type', ITEM_KINDS, '物品 type');
  needText(issues, card, 'description', 'description', '物品 description');
  needText(issues, card, 'function', 'function', '物品 function');
  const rarity = card['rarity'];
  if (rarity === undefined || (typeof rarity === 'string' && !rarity.trim())) {
    warn(issues, 'rarity', 'rarity-missing', '缺少 rarity：图鉴排序与稀有度展示会退化');
  }
}

function validateLore(card: Record<string, unknown>, issues: CardIssue[]): void {
  needEnum(issues, card, 'kind', 'kind', LORE_KINDS, '典籍 kind');
  needText(issues, card, 'content', 'content', '典籍 content');
  const trigger = card['trigger'];
  let constant = false;
  if (trigger !== undefined) {
    if (!isRecord(trigger)) err(issues, 'trigger', 'invalid-type', `trigger 必须是对象，收到 ${typeName(trigger)}`);
    else constant = trigger['constant'] === true;
  }
  const keys = card['keys'];
  if (keys === undefined) {
    if (!constant) err(issues, 'keys', 'missing-field', '典籍 keys 必填（非空数组），除非 trigger.constant 为 true');
  } else if (!Array.isArray(keys)) {
    err(issues, 'keys', 'invalid-type', `keys 必须是字符串数组，收到 ${typeName(keys)}`);
  } else if (keys.length === 0) {
    if (!constant) err(issues, 'keys', 'empty-field', 'keys 不能是空数组，除非 trigger.constant 为 true');
  } else {
    keys.forEach((key, index) => {
      if (typeof key !== 'string' || !key.trim()) err(issues, `keys[${index}]`, 'invalid-value', '触发词必须是非空字符串');
    });
  }
  if (textOf(card['summary']) === undefined) warn(issues, 'summary', 'lore-summary-missing', '缺少 summary：brief 会退化为 content 截断');
}

// ---------------------------------------------------------------- 入口

function validateCardValue(card: Record<string, unknown>, issues: CardIssue[], known: ReadonlySet<string> | undefined): void {
  const cardType = validateBase(card, issues, known);
  switch (cardType) {
    case 'character': validateCharacter(card, issues); break;
    case 'scene': validateScene(card, issues, known); break;
    case 'item': validateItem(card, issues); break;
    case 'lore': validateLore(card, issues); break;
    default: break;
  }
}

export function validateCard(value: unknown, options?: ValidateOptions): CardValidation {
  const issues: CardIssue[] = [];
  try {
    if (!isRecord(value)) err(issues, '', 'invalid-type', `卡片必须是 JSON 对象，收到 ${typeName(value)}`);
    else validateCardValue(value, issues, options?.known_card_ids);
  } catch {
    err(issues, '', 'internal-error', '校验过程中遇到无法读取的数据（例如抛错的 getter），已停止');
  }
  return result(issues);
}

export function validatePack(value: unknown): CardValidation {
  const issues: CardIssue[] = [];
  try {
    if (!isRecord(value)) {
      err(issues, '', 'invalid-type', `世界包清单必须是 JSON 对象，收到 ${typeName(value)}`);
    } else {
      const schema = needText(issues, value, 'schema', 'schema', '世界包 schema');
      if (schema !== undefined && schema !== PACK_SCHEMA) err(issues, 'schema', 'schema-mismatch', `世界包 schema 必须是 ${PACK_SCHEMA}`);
      for (const key of ['id', 'name', 'version', 'language']) needText(issues, value, key, key, `世界包 ${key}`);
      listAt(issues, value, 'card_ids', 'card_ids', '世界包 card_ids', true)?.forEach((id, index) => {
        if (typeof id !== 'string' || !id.trim()) err(issues, `card_ids[${index}]`, 'invalid-value', '卡片 ID 必须是非空字符串');
      });
    }
  } catch {
    err(issues, '', 'internal-error', '校验过程中遇到无法读取的数据（例如抛错的 getter），已停止');
  }
  return result(issues);
}
