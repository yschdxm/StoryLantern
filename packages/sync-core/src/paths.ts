/**
 * 远端路径布局。设计约束：**每个路径只有一个写者**。
 *
 *   devices/<deviceId>-<seq>-<hash8>.json.gz   该设备独占；发现索引（**扁平一层**）
 *   logs/<deviceId>/<blindSessionId>/<seq>-<hash8>.jsonl.gz   该设备独占；内容段
 *   snapshots/<blindSessionId>/<hash>.json.gz  内容寻址；纯优化，可丢弃
 *   assets/<hash>                              内容寻址；大文件不进日志
 *   trash/<yyyymmdd>/...                       GC 缓冲，宽限期后删除
 *
 * 发现流程只读 manifest，**从不 list `logs/**`**：WebDAV/网盘列大目录很慢，
 * 而 manifest 已经写清了"某设备有哪些段"。
 *
 * 为什么 manifest 放在 `devices/` 下的**一层**而不是 `devices/<id>/manifest/`：
 * WebDAV 的 PROPFIND 只列一层（Depth: 1），多级目录要么多次往返、要么依赖
 * 常被禁用的 `Depth: infinity`。扁平化后**一次列目录就能发现全部设备的 manifest**，
 * 既省往返，也让 SMB/FTP/网盘这些更弱的后端同样好使。
 */

export const ROOT_PREFIX = '';
export const DEVICES_PREFIX = 'devices/';
export const LOGS_PREFIX = 'logs/';
export const SNAPSHOTS_PREFIX = 'snapshots/';
export const ASSETS_PREFIX = 'assets/';
export const TRASH_PREFIX = 'trash/';

export function manifestPath(deviceId: string, fileName: string): string {
  return `${DEVICES_PREFIX}${deviceId}-${fileName}`;
}

export function manifestFileName(seq: number, blobHash: string): string {
  return `${String(seq).padStart(8, '0')}-${blobHash.slice(0, 8)}.json.gz`;
}

/** 从扁平路径反解设备与版本。deviceId 允许含 `-`，因此用"恰好 8 位序号"作为分隔锚点。 */
export function parseManifestPath(path: string): { deviceId: string; seq: number; hash8: string } | undefined {
  if (!path.startsWith(DEVICES_PREFIX)) return undefined;
  const name = path.slice(DEVICES_PREFIX.length);
  if (name === '' || name.includes('/')) return undefined;
  const match = /^(.+?)-(\d{8})-([0-9a-f]{8})\.json\.gz$/.exec(name);
  if (!match) return undefined;
  return { deviceId: match[1] as string, seq: Number.parseInt(match[2] as string, 10), hash8: match[3] as string };
}

export function segmentPrefix(deviceId: string, blindSessionId: string): string {
  return `${LOGS_PREFIX}${deviceId}/${blindSessionId}/`;
}

export function segmentPath(deviceId: string, blindSessionId: string, fileName: string): string {
  return `${segmentPrefix(deviceId, blindSessionId)}${fileName}`;
}

export function snapshotPrefix(blindSessionId: string): string {
  return `${SNAPSHOTS_PREFIX}${blindSessionId}/`;
}

export function snapshotPath(blindSessionId: string, contentHash: string): string {
  return `${snapshotPrefix(blindSessionId)}${contentHash}.json.gz`;
}

export function assetPath(contentHash: string): string {
  return `${ASSETS_PREFIX}${contentHash}`;
}

export function trashPath(date: Date, path: string): string {
  const stamp = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;
  return `${TRASH_PREFIX}${stamp}/${path}`;
}

/** 从段路径反解设备与会话（用于校验"段确实躺在它该在的目录里"）。 */
export function parseSegmentPath(path: string): { deviceId: string; blindSessionId: string; fileName: string } | undefined {
  const match = /^logs\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) return undefined;
  return { deviceId: match[1] as string, blindSessionId: match[2] as string, fileName: match[3] as string };
}
