import { SETTING_KEYS } from './types.ts';

/**
 * 多模型路由：**按任务**选模型，失败依次回退。
 *
 * 两条边界，都很重要：
 *  1. **密钥不由这里持有**：应用只存配置元数据（名字/地址/模型名/参数/任务），
 *     API Key 写在宿主 settings 的 `model.profile.<id>.api_key` 上——那些键在 wire 上只回掩码，
 *     所以 key 永远不会进入 WebView。调用时只传 `profileId`（见 Rust 的 `resolve_target`）。
 *  2. **顺序即优先级**：数组顺序就是回退链顺序。用户不需要理解"路由算法"，
 *     只需要知道"排在前面的先用，用不了就用下一个"。
 */

export type ModelTask = 'chat' | 'summary' | 'extract';

export const MODEL_TASKS: ModelTask[] = ['chat', 'summary', 'extract'];

export interface ModelProfile {
  id: string;
  /** 显示名（用户自己起，例如"本地小模型""贵的那家"）。 */
  name: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** 这份配置负责哪些任务；空 = 只当兜底候选。 */
  tasks: ModelTask[];
  enabled: boolean;
}

/** 一份配置的 API Key 存在哪个设置键上（含 `api_key` 因此会被自动掩码）。 */
export function profileKeySetting(id: string): string {
  return `model.profile.${id}.api_key`;
}

/** 解析设置里的配置数组：坏数据一律**跳过**而不是抛错（配置不该让应用起不来）。 */
export function readProfiles(settings: Record<string, string>): ModelProfile[] {
  const raw = settings[SETTING_KEYS.modelProfiles];
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ModelProfile[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const tasks = Array.isArray(record['tasks'])
      ? (record['tasks'].filter((task): task is ModelTask => MODEL_TASKS.includes(task as ModelTask)) as ModelTask[])
      : [];
    out.push({
      id,
      name: typeof record['name'] === 'string' && record['name'].trim() !== '' ? record['name'].trim() : id,
      baseUrl: typeof record['baseUrl'] === 'string' ? record['baseUrl'].trim() : '',
      model: typeof record['model'] === 'string' ? record['model'].trim() : '',
      temperature: typeof record['temperature'] === 'number' && Number.isFinite(record['temperature']) ? record['temperature'] : 0.9,
      maxTokens: typeof record['maxTokens'] === 'number' && Number.isFinite(record['maxTokens']) ? Math.floor(record['maxTokens']) : 1024,
      tasks,
      enabled: record['enabled'] !== false,
    });
  }
  return out;
}

export function serializeProfiles(profiles: readonly ModelProfile[]): string {
  return JSON.stringify(profiles);
}

/** 从旧的单模型设置里合成一份"默认配置"（M1 及以前只有这一组字段）。 */
export function legacyProfile(settings: Record<string, string>): ModelProfile | undefined {
  const baseUrl = (settings[SETTING_KEYS.baseUrl] ?? '').trim();
  const model = (settings[SETTING_KEYS.model] ?? '').trim();
  if (baseUrl === '' || model === '') return undefined;
  const temperature = Number(settings[SETTING_KEYS.temperature]);
  const maxTokens = Number(settings[SETTING_KEYS.maxTokens]);
  return {
    // 空 id = "用默认那组设置"，宿主按这个约定处理
    id: '',
    name: '默认',
    baseUrl,
    model,
    temperature: Number.isFinite(temperature) && temperature > 0 ? temperature : 0.9,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1024,
    tasks: ['chat'],
    enabled: true,
  };
}

/**
 * 某个任务的候选顺序：先任务匹配的，再**没有标任务**的（通用兜底）。
 *
 * 为什么不把"只标了摘要"的配置当对话兜底：任务标签就是用户的**意图声明**，
 * 拿它去干别的活儿会让人意外。想让某份配置当通用兜底，就别给它标任务。
 *
 * 一份配置至少要有地址与模型名才算"能调用"；不完整的直接跳过，
 * 否则用户会看到"回退到了一个没配好的配置"这种莫名其妙的失败。
 */
export function candidatesFor(settings: Record<string, string>, task: ModelTask): ModelProfile[] {
  const usable = (profile: ModelProfile): boolean => profile.enabled && profile.baseUrl !== '' && profile.model !== '';
  const profiles = readProfiles(settings);
  if (profiles.length === 0) {
    const legacy = legacyProfile(settings);
    return legacy === undefined || !usable(legacy) ? [] : [legacy];
  }
  const matching = profiles.filter((profile) => usable(profile) && profile.tasks.includes(task));
  const general = profiles.filter((profile) => usable(profile) && profile.tasks.length === 0);
  return [...matching, ...general];
}

/** 候选的展示名：给可解释性面板与错误信息用。 */
/**
 * 标了这个任务（或不标任务 = 通用兜底）、但**用不了**的配置。
 *
 * 为什么要单独挑出来：界面上原来只说"当前「对话」没有可用配置：至少给一份标上「对话」"——
 * 可用户明明标了，只是那份的接口地址或模型名是空的（或停用了）。那句话会把排查方向带偏。
 */
export function unusableProfiles(settings: Record<string, string>, task: ModelTask): ModelProfile[] {
  return readProfiles(settings).filter(
    (profile) =>
      (profile.tasks.length === 0 || profile.tasks.includes(task)) &&
      (profile.baseUrl === '' || profile.model === '' || !profile.enabled),
  );
}

export function targetLabel(profile: ModelProfile): string {
  if (profile.id === '') return `${profile.name}（${profile.model}）`;
  return profile.tasks.length === 0 ? `${profile.name}（${profile.model}·兜底）` : `${profile.name}（${profile.model}）`;
}
