import type { TauriBridge } from '../../../../packages/wire/src/index.ts';

/**
 * 系统目录选择器（Android SAF）。
 *
 * 为什么只能走这条路：SAF 是 Android 的 Java API，Rust 拿不到 `content://` 树，
 * 所以选择器在 Kotlin 侧实现（`SafPlugin`），这里只负责调用它。
 *
 * **流程上有个坑**：`plugin:saf|pick` 只是"把系统选择器打开"就返回，用户选完是另一件事。
 * 所以必须**轮询** `plugin:saf|root`，直到出现"比这次更晚"的结果。
 * 我第一版是"调完 pick 立刻读 root"，真机上必然读到空——界面显示「还没有选择文件夹」就是这么来的。
 *
 * 现在只做到"选中并记住"：文件读写真正走 SAF（ContentResolver）是下一步，
 * 所以界面会如实说"已选择，但同步还没用它"。
 */
export interface SafPickResult {
  uri: string;
  name: string;
}

const POLL_INTERVAL_MS = 700;
const POLL_TIMEOUT_MS = 120_000;

interface SafRootPayload {
  uri?: string;
  name?: string;
  error?: string;
  /** 写入时间：只有比"开始选之前"更新的结果才算这次的。 */
  at?: number;
}

/** 等这次选择的结果（用户取消也会写一条 error，所以不会一直等）。 */
async function waitForResult(bridge: TauriBridge, since: number): Promise<SafPickResult | { error: string }> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const read = await bridge.invoke<SafRootPayload>('plugin:saf|root');
    if ((read.at ?? 0) > since) {
      if (read.error !== undefined && read.error !== '') return { error: read.error };
      if (read.uri !== undefined && read.uri !== '') return { uri: read.uri, name: read.name ?? '' };
      return { error: '选择器没有返回文件夹' };
    }
    if (Date.now() > deadline) return { error: '等待选择超时（可能没有选择）' };
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export async function pickSafFolder(bridge: TauriBridge | undefined): Promise<SafPickResult | { error: string }> {
  if (bridge === undefined) return { error: '没有宿主，无法打开系统选择器' };
  try {
    // 先记下"上一次结果的时间"，避免把上一次的选择当成这一次的
    const before = await bridge.invoke<SafRootPayload>('plugin:saf|root');
    await bridge.invoke('plugin:saf|pick');
    return await waitForResult(bridge, before.at ?? 0);
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}
