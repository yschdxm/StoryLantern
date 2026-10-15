/**
 * 视口高度：让"整列"跟着**可视视口**缩，而不是只跟着布局视口。
 *
 * 为什么必须有它（真机踩到）：软键盘弹出时，Android WebView 的**布局视口**往往不变，
 * 只有 `visualViewport` 会缩小。而我们贴底的输入栏是按布局视口贴底的，于是**被键盘盖住**——
 * 看不到自己打的字，也点不到「发送」。之前 ChatScreen 里试着用 `padding-bottom` 顶上去，
 * 但整列本身没缩，输入栏只是被推到视口外面，还是被盖住。
 *
 * 做法：把 `visualViewport.height` 写成根上的 CSS 变量 `--app-height`，
 * 根容器用它当高度 → 整列（含输入栏）自然缩到键盘上方。
 * `visualViewport` 在 Chrome 61+ 就有；`dvh` 要 Chrome 108+，这台手机是 104，指望不上。
 */

export interface ViewportLike {
  height: number;
}

/**
 * 纯函数，便于单测：根容器该有多高。
 * 拿不到 visualViewport（桌面浏览器、老 WebView）或数值不合理时，退回布局视口高度。
 */
export function appHeightFrom(innerHeight: number, viewport: ViewportLike | undefined): number {
  if (viewport === undefined || !Number.isFinite(viewport.height) || viewport.height <= 0) return innerHeight;
  // 取小值：可视视口比布局视口小 = 键盘占掉了那部分空间。
  return Math.min(innerHeight, viewport.height);
}

/** 装上 CSS 变量并跟随变化；返回卸载函数（测试里用来收尾）。 */
export function installViewportHeight(): () => void {
  const root = globalThis.document?.documentElement;
  if (root === undefined) return () => undefined;
  const viewport = (globalThis as { visualViewport?: ViewportLike & { addEventListener?: (type: string, handler: () => void) => void; removeEventListener?: (type: string, handler: () => void) => void } }).visualViewport;

  const apply = (): void => {
    root.style.setProperty('--app-height', `${appHeightFrom(globalThis.innerHeight, viewport)}px`);
  };
  apply();

  viewport?.addEventListener?.('resize', apply);
  viewport?.addEventListener?.('scroll', apply);
  globalThis.addEventListener('resize', apply);
  globalThis.addEventListener('orientationchange', apply);

  return () => {
    viewport?.removeEventListener?.('resize', apply);
    viewport?.removeEventListener?.('scroll', apply);
    globalThis.removeEventListener('resize', apply);
    globalThis.removeEventListener('orientationchange', apply);
  };
}
