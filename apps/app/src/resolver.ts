import type { CompositionHost } from '../../../packages/kernel/src/loader.ts';

/**
 * 插件包名 → 模块。浏览器与测试共用同一张表，因此"界面能加载什么"与"测试验证了什么"永远一致。
 * 真实部署里这一步由包解析器完成（npm 安装 + 动态 import），此处先行显式化以便阅读与审计。
 */
export const resolver: CompositionHost = {
  resolve(name: string) {
    switch (name) {
      case '@storylantern/plugin-locale':
        return import('../../../plugins/locale/src/index.ts');
      case '@storylantern/plugin-log-sink':
        return import('../../../plugins/log-sink/src/index.ts');
      case '@storylantern/plugin-settings-store':
        return import('../../../plugins/settings-store/src/index.ts');
      case '@storylantern/plugin-context-blocks':
        return import('../../../plugins/context-blocks/src/index.ts');
      case '@storylantern/plugin-writing-pipeline':
        return import('../../../plugins/writing-pipeline/src/index.ts');
      case '@storylantern/plugin-sync-memory':
        return import('../../../plugins/sync-memory/src/index.ts');
      case '@storylantern/plugin-sync-webdav':
        // 只依赖全局 fetch：NAS / Nextcloud / 坚果云都自带的协议，移动端也只需填一个 URL
        return import('../../../plugins/sync-webdav/src/index.ts');
      case '@storylantern/plugin-sync-s3':
        // S3 兼容对象存储（MinIO / R2 / B2 / AWS）：同样只用全局 fetch，SigV4 在插件里自实现
        return import('../../../plugins/sync-s3/src/index.ts');
      // 注意：`plugin-sync-folder`（以及将来的 SMB/FTP 后端）依赖 node:fs / node:path，
      // 属于**桌面/移动壳**的能力，浏览器产物里刻意不提供。core bundle 把它标成 disabled，
      // 因此不会被解析；哪天真的在浏览器里启用它，激活会明确失败而不是静默降级。
      default:
        throw new Error(`未知或平台不支持的插件包 ${name}`);
    }
  },
};
