import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 界面产物。
 *
 * 注意两件事：
 *  1. 功能集合**不由本文件决定**——它由各 bundle 的 storylantern.patch.yml 组合出来
 *     （composition.ts 用 `?raw` 把 patch 当数据引入），因此"开/关一个功能"不需要改构建配置。
 *  2. 目前只有一个 SPA 产物；Tauri 壳（apps/shell）以后直接包这一份。
 *
 * 踩过的坑：在块注释里写 `bundles/*​/...` 这类 glob 会因为里面的 `*​/` 提前终结注释。
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 移动端 WebView 目标：es2022 足够新，又不必为老 WebView 做 polyfill
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5199,
  },
});
