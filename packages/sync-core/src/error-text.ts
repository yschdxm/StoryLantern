/**
 * 把一个"抛出来的东西"变成能给人看的一句话。
 *
 * 为什么住在包里：`sync-core` 自己要判断"读不到 ≠ 还没有"，而**包不能依赖 app**；
 * 界面那侧通过 `apps/app/src/data/error-text.ts` 转发到这里，全仓只有这一份实现。
 *
 * 为什么需要它：界面上原先有三十多处写的是
 * `cause instanceof Error ? cause.message : String(cause)`——
 * 而 **Tauri 插件拒绝时抛的是普通对象、不是 `Error`**，于是 `String(cause)` 得到
 * `[object Object]`。真机踩到：把同步方式切到"本地文件夹"、SAF 又没启用时，
 * 界面显示的是 `Sync failed: [object Object]`——等于什么也没说，
 * 我们那一整套"如实报错、不静默失败"的努力也就白费了。
 *
 * 规则（从最可信的形状往下退）：
 *  1. `Error` → `message`（空则用 `name`）；
 *  2. 字符串 → 原样；
 *  3. 对象 → 依次找 `message` / `error` / `reason` / `detail`（值是对象就递归）；
 *  4. 再退回 JSON；连 JSON 都不行（循环引用等）→ 一句说明"对方没给可读信息"。
 */
export function describeError(cause: unknown): string {
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message;
  if (typeof cause === 'string') return cause;
  if (cause === null || typeof cause !== 'object') return String(cause);

  const record = cause as Record<string, unknown>;
  for (const key of ['message', 'error', 'reason', 'detail'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (value !== null && typeof value === 'object') {
      const nested = describeError(value);
      if (nested !== '') return nested;
    }
  }

  try {
    const text = JSON.stringify(cause);
    if (text !== undefined && text !== '{}' && text !== 'null') return text;
  } catch {
    // 循环引用之类：下面兜底
  }
  return '未知错误（对方给了一个没有可读信息的对象）';
}
