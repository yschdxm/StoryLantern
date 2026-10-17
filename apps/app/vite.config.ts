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

/**
 * 端口必须避开 Windows/Hyper-V 的动态保留段，否则 `listen` 直接返回 `EACCES`
 * （本机保留段包含 5141–5240，因此 **Vite 默认的 5173 与之前的 5199 都绑不上**）。
 * 查保留段：`netsh interface ipv4 show excludedportrange protocol=tcp`
 */
const PORT = 15199;

export default defineConfig({
  plugins: [react()],
  // 构建时间戳打进界面：装到设备上"改了没生效"时，一眼就能确认跑的是哪一版
  define: {
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 移动端 WebView 目标：es2022 足够新，又不必为老 WebView 做 polyfill
    target: 'es2022',
    // **不产 sourcemap**：dist 就是 Tauri 的 frontendDist，`.map` 会一起打进安装包
    // （实测多出约 2.6 MB，而且等于把源码随包发出去）。开发服务器本来就有自己的 sourcemap，
    // 调试不受影响；`scripts/check-bundle.mjs` 现在会拦住"产物里出现 .map"。
    sourcemap: false,
  },
  server: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
  },
  preview: {
    port: PORT,
    strictPort: true,
    host: '127.0.0.1',
  },
});
