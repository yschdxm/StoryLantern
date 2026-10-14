/// <reference types="vite/client" />

// Vite 的 `?raw` 导入（把 patch 当数据引入），由上面的引用提供类型。

/** 构建时注入的时间戳（见 vite.config.ts 的 define）。 */
declare const __BUILD_STAMP__: string;
