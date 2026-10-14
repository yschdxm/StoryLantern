import type { TauriBridge } from '../../../../packages/wire/src/index.ts';
import type { SyncBackend } from '../../../../packages/sync-core/src/backend.ts';
import { createFolderBackend, type FilePort } from './sync/folder-backend.ts';

/**
 * 用系统选择器选中的文件夹（Android SAF）作为同步目录。
 *
 * 为什么只能这样做：SAF 的读写是 Java API，Rust 拿不到 `content://` 树，
 * 所以这里把 `FilePort` 接到 Kotlin 插件上，再交给既有的 `createFolderBackend`——
 * 同步逻辑**一行都不用改**（同一套代码在 Node 里用内存端口测过）。
 *
 * 路径都是相对于选中目录的相对路径；文件内容用 base64 过桥（与 host 的 files.* 一致）。
 */

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

interface SafEntry {
  path: string;
  size: number;
  mtime?: number;
}

export function createSafFilePort(bridge: TauriBridge): FilePort {
  return {
    async list(prefix) {
      const result = await bridge.invoke<{ entries: SafEntry[] }>('plugin:saf|list', { prefix });
      return result.entries.map((entry) => ({
        path: entry.path,
        size: entry.size,
        ...(entry.mtime === undefined ? {} : { mtime: entry.mtime }),
      }));
    },
    async read(path) {
      const result = await bridge.invoke<{ base64: string }>('plugin:saf|read', { path });
      return decodeBase64(result.base64);
    },
    async write(path, bytes, options) {
      return bridge.invoke<{ ok: boolean; exists?: boolean }>('plugin:saf|write', {
        path,
        base64: encodeBase64(bytes),
        ifNoneMatch: options?.ifNoneMatch === true,
      });
    },
    async delete(path) {
      await bridge.invoke<{ removed: boolean }>('plugin:saf|remove', { path });
    },
  };
}

/** 把 SAF 目录包装成同步后端。 */
export function createSafFolderBackend(bridge: TauriBridge): SyncBackend {
  return createFolderBackend(createSafFilePort(bridge));
}
