/**
 * **可分享的配置档（profile）**：把"界面设置 + bundle patch"打包成一个 JSON 文件，
 * 让别人导入同一套用法（模型配置、提示词块预算、同步后端这些**不含密钥**的部分）。
 *
 * 三条硬规矩（都是安全相关的）：
 *  1. **密钥永不进配置档**：导出时按键名模式剔除（api_key / password / secret / token / 私钥），
 *     并在结果里报告"剔除了几个键"；导入时同样拒绝任何看起来像密钥的字段；
 *  2. **不认识的格式不猜**：`format` 不是我们的就明确报错，而不是"尽力解析"；
 *  3. **可审计**：导出物带 format/version/createdAt，导入时把"跳过了什么、改了什么"写进 notes。
 */

export const PROFILE_FORMAT = 'storylantern-profile';
export const PROFILE_VERSION = 1;

/** 看起来是密钥的键名（大小写不敏感）。宁可多剔，也不能漏。 */
const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|password|passwd|secret|token|private[_-]?key|keystore)/i;

export interface ProfileFile {
  format: typeof PROFILE_FORMAT;
  version: number;
  createdAt: string;
  /** 设置项（键 → 字符串）。密钥类键已在导出时剔除。 */
  settings: Record<string, string>;
  /** 用户的 bundle patch 全文（可选）。 */
  patch?: string;
}

export interface ExportProfileInput {
  settings: Readonly<Record<string, string>>;
  patch?: string;
  now?: Date;
}

export interface ExportProfileResult {
  profile: ProfileFile;
  /** 被剔除的键名（只报键名，不报值）。 */
  removedKeys: string[];
}

export function exportProfile(input: ExportProfileInput): ExportProfileResult {
  const settings: Record<string, string> = {};
  const removedKeys: string[] = [];
  for (const [key, value] of Object.entries(input.settings)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      removedKeys.push(key);
      continue;
    }
    settings[key] = value;
  }
  return {
    profile: {
      format: PROFILE_FORMAT,
      version: PROFILE_VERSION,
      createdAt: (input.now ?? new Date()).toISOString(),
      settings,
      ...(input.patch === undefined || input.patch.trim() === '' ? {} : { patch: input.patch }),
    },
    removedKeys,
  };
}

export interface ImportProfileResult {
  profile: ProfileFile;
  /** 导入时需要告诉用户的事（跳过的密钥键、版本差异…）。 */
  notes: string[];
  removedKeys: string[];
}

export class ProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
  }
}

/** 解析配置档：格式不对/版本比我们新/带密钥字段 → 明确报错或剔除，不"尽力而为"。 */
export function parseProfile(input: unknown): ImportProfileResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProfileError('bad-profile', '配置档不是对象');
  }
  const bag = input as Record<string, unknown>;
  if (bag['format'] !== PROFILE_FORMAT) {
    throw new ProfileError('unknown-format', '这不是叙灯的配置档（format 不匹配）');
  }
  const version = typeof bag['version'] === 'number' ? bag['version'] : Number.NaN;
  if (!Number.isFinite(version) || version > PROFILE_VERSION) {
    throw new ProfileError('newer-version', `配置档版本 ${String(bag['version'])} 比当前支持的 ${PROFILE_VERSION} 新，请升级后再导入`);
  }
  const rawSettings = bag['settings'];
  if (typeof rawSettings !== 'object' || rawSettings === null || Array.isArray(rawSettings)) {
    throw new ProfileError('bad-settings', '配置档里的 settings 不是对象');
  }

  const settings: Record<string, string> = {};
  const removedKeys: string[] = [];
  for (const [key, value] of Object.entries(rawSettings as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      removedKeys.push(key);
      continue;
    }
    if (typeof value !== 'string') {
      throw new ProfileError('bad-setting', `设置项 ${key} 不是字符串`);
    }
    settings[key] = value;
  }

  const notes: string[] = [];
  if (removedKeys.length > 0) notes.push(`${removedKeys.length} 个密钥类设置被拒绝导入（配置档不应携带密钥）`);
  if (version < PROFILE_VERSION) notes.push(`配置档版本 ${version} 较旧，已按当前规则读取`);

  const patch = bag['patch'];
  if (patch !== undefined && typeof patch !== 'string') {
    throw new ProfileError('bad-patch', '配置档里的 patch 不是字符串');
  }

  return {
    profile: {
      format: PROFILE_FORMAT,
      version: PROFILE_VERSION,
      createdAt: typeof bag['createdAt'] === 'string' ? bag['createdAt'] : '',
      settings,
      ...(patch === undefined || patch.trim() === '' ? {} : { patch }),
    },
    notes,
    removedKeys,
  };
}
