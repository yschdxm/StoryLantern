import type { TauriBridge } from '../../../../packages/wire/src/index.ts';

/**
 * 系统目录选择器（Android SAF）。
 *
 * 为什么只能走这条路：SAF 是 Android 的 Java API，Rust 拿不到 `content://` 树，
 * 所以选择器在 Kotlin 侧实现（`SafPlugin`），这里只是调用它。
 *
 * 现在只做到"选中并记住"：文件读写真正走 SAF（ContentResolver）是下一步——
 * 所以界面会说清"已选择，但同步还没用它"，不假装已经接管。
 */
export interface SafPickResult {
  uri: string;
  name: string;
}

export async function pickSafFolder(bridge: TauriBridge | undefined): Promise<SafPickResult | { error: string }> {
  if (bridge === undefined) return { error: '没有宿主，无法打开系统选择器' };
  try {
    await bridge.invoke('plugin:saf|pick');
    const read = await bridge.invoke<{ uri?: string; name?: string; error?: string }>('plugin:saf|root');
    if (read.error !== undefined && read.error !== '') return { error: read.error };
    if (read.uri === undefined || read.uri === '') return { error: '还没有选择文件夹' };
    return { uri: read.uri, name: read.name ?? '' };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}
