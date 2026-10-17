/**
 * **PlatformPort**：界面代码访问"平台能力"的唯一入口。
 *
 * 为什么需要它：界面里到处是 `navigator.clipboard` / `window.matchMedia` / `fetch` 这类**宿主差异**。
 * 直接调用会让同一段界面逻辑在 Tauri WebView、浏览器、Node 测试里表现不同，而且测试里没法替换。
 * 把这个边界显式化之后：界面只依赖这个端口，测试用内存实现、浏览器用 Web 实现、将来 Tauri 可以自己实现。
 *
 * 边界故意**很小**：只收"界面确实需要、且各平台实现会不同"的几项。存储/网络/文件已经有各自的
 * 端口（`sync/app-sync.ts`、`host-fetch.ts`、`saf.ts`），不要往这里塞第二套。
 */

export interface ClipboardPort {
  /** 写文本；失败要抛（调用方据此提示"复制失败"）。 */
  write(text: string): Promise<void>;
  /** 读文本；不可用时抛。 */
  read(): Promise<string>;
}

export interface PlatformPort {
  /** 平台名（显示/排错用）。 */
  readonly kind: string;
  readonly clipboard: ClipboardPort;
  /** 本机时间（毫秒）。抽出来是为了测试能固定时间。 */
  now(): number;
}

/** Web / WebView 实现：只有 `navigator.clipboard` 可用时才真能用。 */
export function createWebPlatformPort(): PlatformPort {
  const requireClipboard = (): Clipboard => {
    const clipboard = (globalThis as { navigator?: { clipboard?: Clipboard } }).navigator?.clipboard;
    if (clipboard === undefined) throw new Error('这个环境没有剪贴板（navigator.clipboard 不可用）');
    return clipboard;
  };
  return {
    kind: 'web',
    clipboard: {
      async write(text) {
        await requireClipboard().writeText(text);
      },
      async read() {
        return requireClipboard().readText();
      },
    },
    now: () => Date.now(),
  };
}

/** 内存实现：测试用，同时也能当"平台能力不可用"时的降级（读=空串、写=存起来）。 */
export function createMemoryPlatformPort(options: { now?: () => number } = {}): PlatformPort & { clipboardText(): string } {
  let text = '';
  return {
    kind: 'memory',
    clipboard: {
      async write(value) {
        text = value;
      },
      async read() {
        return text;
      },
    },
    now: options.now ?? (() => 1_700_000_000_000),
    clipboardText: () => text,
  };
}
