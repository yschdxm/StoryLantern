/**
 * Bundle 约定。
 *
 * 一个 bundle 就是一个 npm 包，它的 `package.json` 通过
 * `storylantern.bundle.patch` 指向一个 patch 文件；patch 做什么由组合层解释。
 * 这样"功能集合"与"功能实现"彻底分离：bundle 本身没有业务代码。
 */

export interface BundleManifest {
  /** 包名，用于诊断与循环检测。 */
  name: string;
  /** patch 文件相对包目录的路径。 */
  patch: string;
}

export function bundlePatchOf(packageJson: unknown): BundleManifest | undefined {
  if (packageJson === null || typeof packageJson !== 'object') return undefined;
  const record = packageJson as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name : undefined;
  const storylantern = record.storylantern;
  if (!name || storylantern === null || typeof storylantern !== 'object') return undefined;
  const bundle = (storylantern as Record<string, unknown>).bundle;
  if (bundle === null || typeof bundle !== 'object') return undefined;
  const patch = (bundle as Record<string, unknown>).patch;
  if (typeof patch !== 'string' || patch === '') return undefined;
  return { name, patch };
}

export interface ProfilePackageJson {
  name: string;
  storylantern?: { profile?: { bundles?: string[] } };
}

/** 读取 profile 声明的 bundle 列表（`storylantern.profile.bundles`）。 */
export function profileBundlesOf(packageJson: unknown): string[] {
  if (packageJson === null || typeof packageJson !== 'object') return [];
  const record = packageJson as Record<string, unknown>;
  const storylantern = record.storylantern;
  if (storylantern === null || typeof storylantern !== 'object') return [];
  const profile = (storylantern as Record<string, unknown>).profile;
  if (profile === null || typeof profile !== 'object') return [];
  const bundles = (profile as Record<string, unknown>).bundles;
  if (!Array.isArray(bundles)) return [];
  return bundles.filter((item): item is string => typeof item === 'string');
}
