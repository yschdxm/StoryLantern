import { defineConfig, devices } from '@playwright/test';

/**
 * e2e：**移动视口 + 触摸**（PLAN 里"移动优先"的验收层）。
 *
 * 为什么用 Playwright：真浏览器 + 真触摸事件，这是唯一能测到"拇指可达/触摸目标尺寸/
 * 窄屏不横向溢出"这些手机约束的办法。它只是 **devDependency**（运行时依赖仍然是零）。
 *
 * 被测对象是 Vite 的 dev server：它在浏览器里跑（无宿主 IPC），界面会诚实地显示"浏览器（无宿主 IPC）"，
 * 正好覆盖"没有宿主时界面不炸"这条。
 */
const PORT = 15199;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // 测**真实构建产物**（dist + vite preview），不是 dev server：
    // dev 模式下 Vite 不做 tree-shaking，会把 packages/oplog 里 node 专用的模块（node:zlib）
    // 一起拉进浏览器模块图并当场报错（实测 pageerror: Module "node:zlib" has been externalized）。
    // 也就是说"浏览器里跑 dev server"本来就是坏的；e2e 要覆盖的是用户真正拿到的产物。
    command: 'node apps/shell/build-frontend.mjs && pnpm --filter @storylantern/app exec vite preview --port 15199 --strictPort',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
