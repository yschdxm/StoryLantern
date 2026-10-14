import { WireClient, type WireTransport } from '../../../../../packages/wire/src/index.ts';
import type { SyncBackend, ListResult, PutResult } from '../../../../../packages/sync-core/src/backend.ts';

/**
 * "同步到本地文件夹"的后端。
 *
 * 分两层：`createFolderBackend` 只依赖一个**文件端口**（因此能在 Node 里用内存实现测），
 * `createHostFolderBackend` 把端口接到宿主的 `files.*` 上。
 *
 * 为什么文件操作要绕宿主：一份前端产物同时跑浏览器与 Tauri，往里引 `node:fs` 会让移动端直接崩；
 * 和"宿主发 HTTP"是同一个理由。宿主那边还有三条边界（路径不许逃出根目录、根目录可配置、
 * 支持"不存在才写"）——见 `apps/shell/src-tauri/src/files.rs`。
 */

export interface FilePort {
  list(prefix: string): Promise<Array<{ path: string; size: number; mtime?: number }>>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array, options?: { ifNoneMatch?: boolean }): Promise<PutResult>;
  delete(path: string): Promise<void>;
}

export function createFolderBackend(files: FilePort): SyncBackend {
  return {
    id: 'folder',
    capabilities: { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false },
    async list(prefix: string): Promise<ListResult> {
      const entries = await files.list(prefix);
      return { entries: entries.map((entry) => ({ path: entry.path, size: entry.size, ...(entry.mtime === undefined ? {} : { mtime: entry.mtime }) })) };
    },
    get: (path: string) => files.read(path),
    put: (path: string, bytes: Uint8Array, options?: { ifNoneMatch?: boolean }) => files.write(path, bytes, options),
    delete: (path: string) => files.delete(path),
  };
}

interface WireFilesEntry {
  path: string;
  size: number;
  mtime?: number;
}

/** 走宿主的实现：base64 是 wire 上搬二进制的方式。 */
export function createHostFolderBackend(transport: WireTransport): SyncBackend {
  const client = new WireClient(transport);

  return createFolderBackend({
    async list(prefix) {
      const result = await client.call<{ entries: WireFilesEntry[] }>('files', 'list', prefix);
      return result.entries;
    },
    async read(path) {
      const result = await client.call<{ base64: string }>('files', 'read', path);
      return decodeBase64(result.base64);
    },
    async write(path, bytes, options) {
      const result = await client.call<{ ok: boolean; exists?: boolean }>(
        'files',
        'write',
        path,
        encodeBase64(bytes),
        options?.ifNoneMatch === true,
      );
      return result;
    },
    async delete(path) {
      await client.call<{ removed: boolean }>('files', 'delete', path);
    },
  });
}

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
