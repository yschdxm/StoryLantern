import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BackendCapabilities,
  BackendEntry,
  ListResult,
  PutResult,
  SyncBackend,
} from '../../../packages/sync-core/src/backend.ts';

/** 保守能力声明：网盘目录没有条件写、没有范围读、也没有推送。 */
const CAPABILITIES: BackendCapabilities = {
  conditionalPut: false,
  rangeRead: false,
  delete: true,
  listPagination: false,
  watch: false,
};

export interface FolderBackendOptions {
  root: string;
  capabilities?: Partial<BackendCapabilities>;
}

/** 路径安全：任何越出 root 的相对路径都必须被拒绝（同步目录里不该写别处）。 */
function resolveSafe(root: string, relative: string): string {
  const normalized = path.posix.normalize(relative);
  if (normalized.startsWith('..') || path.isAbsolute(normalized) || normalized.includes('\0')) {
    throw new Error(`非法同步路径：${relative}`);
  }
  const full = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
    throw new Error(`同步路径越界：${relative}`);
  }
  return full;
}

async function walk(dir: string, root: string, out: BackendEntry[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out);
      continue;
    }
    const relative = path.relative(root, full).split(path.sep).join('/');
    const info = await stat(full);
    out.push({ path: relative, size: info.size, mtime: info.mtimeMs });
  }
}

/**
 * 文件夹后端。
 *
 * 这是"普通用户零部署"的主力：把同步目录指向 OneDrive/坚果云/Syncthing 的本地文件夹，
 * 或 NAS 的挂载盘即可，不需要任何服务器进程。
 *
 * 注意：写入采用"先写临时文件再 rename"，但在被网盘客户端并发同步的目录里，
 * rename 的原子性并不由我们保证——所以协议本身不依赖原子性：
 * 文件名含内容摘要、写入失败复测、发布后回读校验三者合起来足以保证正确性。
 */
export function createFolderBackend(options: FolderBackendOptions): SyncBackend {
  const root = path.resolve(options.root);
  const capabilities: BackendCapabilities = { ...CAPABILITIES, ...options.capabilities };

  return {
    id: `folder:${root}`,
    capabilities,

    async list(prefix: string): Promise<ListResult> {
      const start = resolveSafe(root, prefix);
      const out: BackendEntry[] = [];
      await walk(start, root, out);
      out.sort((a, b) => a.path.localeCompare(b.path));
      return { entries: out };
    },

    async get(target: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(resolveSafe(root, target)));
    },

    async put(target: string, bytes: Uint8Array, putOptions?: { ifNoneMatch?: boolean }): Promise<PutResult> {
      const full = resolveSafe(root, target);
      if (putOptions?.ifNoneMatch === true) {
        const exists = await stat(full).then(
          () => true,
          () => false,
        );
        if (exists) return { ok: false, exists: true };
      }
      await mkdir(path.dirname(full), { recursive: true });
      const temp = `${full}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temp, bytes);
      await rename(temp, full);
      return { ok: true };
    },

    async delete(target: string): Promise<void> {
      await rm(resolveSafe(root, target), { force: true });
    },
  };
}

/** 作为插件注册：`ctx.set('sync.backend.folder', ...)`。 */
export function apply(ctx: {
  set(key: string, value: unknown): unknown;
}): void {
  ctx.set('sync.backend.folder', { kind: 'folder', create: createFolderBackend });
}
