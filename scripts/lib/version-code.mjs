/**
 * 生产版 versionCode 的**唯一实现**。
 *
 * `scripts/android-channel.mjs`（写进 Gradle）与 `scripts/check-version-no-rollback.mjs`（发布前守卫）
 * 必须用同一套算法 —— 否则会出现"守卫说没回退、包里却写着另一个版本码"这种最难查的不一致。
 *
 * 规则：`major*10000 + minor*100 + patch`（0.0.1 → 1；1.2.3 → 10203）。
 * 每个段留 100 的空间（补丁号 0–99、次版本 0–99），够用且直观。
 */
export function versionCodeOf(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (match === null) return undefined;
  const [, major, minor, patch] = match;
  return Number(major) * 10000 + Number(minor) * 100 + Number(patch);
}
