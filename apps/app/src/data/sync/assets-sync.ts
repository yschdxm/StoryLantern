/**
 * 资产（图片）同步：本机资产库 ↔ 哑存储。
 *
 * 与 op/段同步的区别：二进制不进日志，远端按**密文哈希**命名（ADR-0008）。
 * 所以一次资产同步由两半组成：
 *  1. **上传**：本机 `assets.list()` → 缺的字节 `createAssetStore.put` → 记映射，最后发布索引；
 *  2. **下载**：只拉「当前卡片真正引用」的图（`visuals[].path` / `meta.cover`）——
 *     懒加载：索引里有但没被引用的图不下载，避免一同步就拉整个资产库。
 *
 * 失败策略：任何一步失败只进 `warnings`，绝不阻断 op 同步；计数用于同步摘要。
 */

import { toHex } from '../../../../../packages/oplog/src/bytes.ts';
import type { CryptoPorts, MaterializedState } from '../../../../../packages/oplog/src/index.ts';
import {
  ASSET_INDEX_PREFIX,
  decodeAssetIndex,
  encodeAssetIndex,
  parseAssetIndexPath,
  type AssetIndexEntry,
} from '../../../../../packages/sync-core/src/asset-index.ts';
import { createAssetStore } from '../../../../../packages/sync-core/src/asset.ts';
import type { SyncBackend } from '../../../../../packages/sync-core/src/backend.ts';
import { getAssetClient, hashOfAssetRef, type AssetClient } from '../asset-client.ts';
import { describeError } from '../error-text.ts';
import type { DeviceStore } from '../op-ports.ts';

/** 设备本地 kv：明文 sha256 → 远端密文哈希（JSON `Record<plain, cipher>`）。 */
export const SYNC_ASSET_MAP_KEY = 'sync.asset-map.v1';
/** 设备本地 kv：本机资产索引序号（单调递增，远端清单也参与取最大值）。 */
export const SYNC_ASSET_INDEX_SEQ_KEY = 'sync.asset-index-seq.v1';

/** 单次下载上限：超了告警、下次继续（避免一次同步把流量打满）。 */
export const MAX_ASSET_DOWNLOADS = 50;
export const MAX_ASSET_DOWNLOAD_BYTES = 64 * 1024 * 1024;

const HEX64 = /^[0-9a-f]{64}$/;

export interface MaterializerLike {
  readonly state: MaterializedState;
}

export interface AssetSyncInput {
  backend: SyncBackend;
  /** 与 op 段相同的加密端口（内容密钥可用时由同步服务传入那一套）。 */
  ports: CryptoPorts;
  device: DeviceStore;
  deviceId: string;
  materializer: MaterializerLike;
  /** 测试注入；默认走 `getAssetClient()`（宿主或浏览器内存实现）。 */
  assetClient?: AssetClient;
  now?: () => number;
}

export interface AssetSyncSummary {
  uploaded: number;
  downloaded: number;
  skipped: number;
  /** 本次发布的索引序号；没发布则为本机已知的最新序号。 */
  indexSeq: number | undefined;
  warnings: string[];
}

interface PeerIndex {
  deviceId: string;
  seq: number;
  entries: ReadonlyMap<string, AssetIndexEntry>;
}

/** 当前物化状态里所有卡片引用的资产 sha256（懒加载的请求集）。 */
export function collectAssetHashes(state: MaterializedState): string[] {
  const hashes = new Set<string>();
  for (const record of Object.values(state.cards)) {
    const card = record.card;
    for (const visual of card.visuals ?? []) {
      const hash = hashOfAssetRef(visual.path);
      if (hash !== undefined) hashes.add(hash);
    }
    const cover = hashOfAssetRef(card.meta.cover);
    if (cover !== undefined) hashes.add(cover);
  }
  return [...hashes].sort();
}

function parseMap(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [plain, cipher] of Object.entries(parsed as Record<string, unknown>)) {
      if (HEX64.test(plain) && typeof cipher === 'string' && HEX64.test(cipher)) out[plain] = cipher;
    }
    return out;
  } catch {
    // 坏映射只意味着"下次多传一遍"，不是失败
    return {};
  }
}

async function sha256Hex(ports: CryptoPorts, bytes: Uint8Array): Promise<string> {
  return toHex(await ports.digest.sha256(bytes));
}

/** 发现远端所有设备的最新索引（同设备只看最大 seq）。读失败的只告警，不影响其它设备。 */
async function readLatestIndexes(input: AssetSyncInput, warnings: string[]): Promise<Map<string, PeerIndex>> {
  const latest = new Map<string, { seq: number; path: string; hash8: string }>();
  let listing: { entries: { path: string; size: number }[] };
  try {
    listing = await input.backend.list(ASSET_INDEX_PREFIX);
  } catch (cause) {
    // 远端还没建过 assets/index/ 目录是正常状态（第一次同步），不是告警
    if (/404|not found|不存在/i.test(describeError(cause))) return new Map();
    throw cause;
  }
  for (const entry of listing.entries) {
    const parsed = parseAssetIndexPath(entry.path);
    if (parsed === undefined) continue;
    const current = latest.get(parsed.deviceId);
    if (current === undefined || parsed.seq > current.seq) {
      latest.set(parsed.deviceId, { seq: parsed.seq, path: entry.path, hash8: parsed.hash8 });
    }
  }

  const indexes = new Map<string, PeerIndex>();
  for (const [deviceId, info] of [...latest.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      const bytes = await input.backend.get(info.path);
      // 路径里的 hash8 是整份字节的摘要：对不上说明文件被换过（解码前先挡掉）
      if (!(await sha256Hex(input.ports, bytes)).startsWith(info.hash8)) {
        throw new Error(`索引文件名里的摘要与内容不符（${info.hash8}）`);
      }
      const decoded = await decodeAssetIndex(bytes, { ports: input.ports, deviceId, seq: info.seq });
      indexes.set(deviceId, {
        deviceId,
        seq: info.seq,
        entries: new Map(decoded.index.entries.map((entry) => [entry.plain, entry] as const)),
      });
    } catch (cause) {
      warnings.push(`资产索引 ${info.path} 读取失败：${describeError(cause)}`);
    }
  }
  return indexes;
}

async function remoteHas(assetStore: ReturnType<typeof createAssetStore>, cipher: string): Promise<boolean> {
  try {
    return await assetStore.has(cipher);
  } catch {
    // 远端暂时不可达时按"没有"处理：下一轮会重传（内容寻址，重复上传无害）
    return false;
  }
}

function sameEntries(a: readonly AssetIndexEntry[], b: readonly AssetIndexEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return other !== undefined && other.plain === entry.plain && other.cipher === entry.cipher && other.bytes === entry.bytes;
  });
}

/** 清理本机旧索引：只保留最近 2 份（尽力而为，删不掉只说明空间多占一点）。 */
async function pruneOwnIndexes(input: AssetSyncInput, keepSeq: number): Promise<void> {
  const listing = await input.backend.list(ASSET_INDEX_PREFIX);
  const own: { path: string; seq: number }[] = [];
  for (const entry of listing.entries) {
    const parsed = parseAssetIndexPath(entry.path);
    if (parsed === undefined || parsed.deviceId !== input.deviceId) continue;
    own.push({ path: entry.path, seq: parsed.seq });
  }
  own.sort((a, b) => b.seq - a.seq);
  // 新发布的那份 + 上一份 = 2 份；更旧的尽力删
  const keep = new Set<number>([keepSeq]);
  const previous = own.find((item) => item.seq !== keepSeq);
  if (previous !== undefined) keep.add(previous.seq);
  if (input.backend.delete === undefined) return;
  for (const item of own) {
    if (keep.has(item.seq)) continue;
    try {
      await input.backend.delete(item.path);
    } catch {
      // 旧索引删不掉不影响正确性（每台设备只写自己的命名空间）
    }
  }
}

/** 上传本机资产并发布索引；返回本机完整条目（含跳过/新上传的）。 */
async function uploadLocalAssets(
  input: AssetSyncInput,
  client: AssetClient,
  own: PeerIndex | undefined,
  mapping: Record<string, string>,
  warnings: string[],
): Promise<{ entries: AssetIndexEntry[]; uploaded: number; skipped: number; changed: boolean }> {
  const assetStore = createAssetStore({ backend: input.backend, ports: input.ports });
  const localHashes = (await client.list()).filter((hash) => HEX64.test(hash)).sort();
  const limited = localHashes.slice(0, 2000);
  if (localHashes.length > limited.length) {
    warnings.push(`本机资产超过 ${limited.length} 个，本次只处理前一批；下次同步继续。`);
  }
  const entries: AssetIndexEntry[] = [];
  let uploaded = 0;
  let skipped = 0;
  let changed = false;

  for (const plain of limited) {
    const known = own?.entries.get(plain) ?? (mapping[plain] === undefined ? undefined : { plain, cipher: mapping[plain], bytes: 0 });
    if (known !== undefined && (await remoteHas(assetStore, known.cipher))) {
      entries.push(known);
      skipped += 1;
      continue;
    }
    const bytes = await client.get(plain);
    if (bytes === undefined) {
      warnings.push(`本地资产 ${plain} 读不到字节，已跳过（卡片仍引用它，界面会显示缺图）`);
      continue;
    }
    const put = await assetStore.put(bytes);
    if (put.uploaded) uploaded += 1;
    else skipped += 1;
    entries.push({ plain, cipher: put.hash, bytes: put.bytes });
    if (mapping[plain] !== put.hash) {
      mapping[plain] = put.hash;
      changed = true;
    }
  }
  return { entries, uploaded, skipped, changed };
}

/** 下载被引用但本机缺失的资产（懒加载 + 单次预算 + sha256 校验）。 */
async function downloadRequestedAssets(
  input: AssetSyncInput,
  client: AssetClient,
  indexes: Map<string, PeerIndex>,
  localHashes: ReadonlySet<string>,
  mapping: Record<string, string>,
  warnings: string[],
): Promise<{ downloaded: number; changed: boolean }> {
  const requested = collectAssetHashes(input.materializer.state).filter((hash) => !localHashes.has(hash));
  if (requested.length === 0) return { downloaded: 0, changed: false };

  const assetStore = createAssetStore({ backend: input.backend, ports: input.ports });
  const peers = [...indexes.values()]
    .filter((index) => index.deviceId !== input.deviceId)
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  let downloaded = 0;
  let bytesSoFar = 0;
  let noMapping = 0;
  let changed = false;
  let budgetHit = false;

  for (const plain of requested) {
    const candidates: { deviceId: string; entry: AssetIndexEntry }[] = [];
    for (const peer of peers) {
      const entry = peer.entries.get(plain);
      if (entry !== undefined) candidates.push({ deviceId: peer.deviceId, entry });
    }
    if (candidates.length === 0) {
      noMapping += 1;
      continue;
    }
    if (downloaded >= MAX_ASSET_DOWNLOADS || bytesSoFar >= MAX_ASSET_DOWNLOAD_BYTES) {
      budgetHit = true;
      break;
    }

    for (const candidate of candidates) {
      try {
        const bytes = await assetStore.get(candidate.entry.cipher);
        if ((await sha256Hex(input.ports, bytes)) !== plain) {
          warnings.push(`资产 ${plain} 校验失败：远端 ${candidate.entry.cipher} 的内容与卡片引用不符（可能被篡改或索引指错），已拒绝落库`);
          continue;
        }
        const storedHash = await client.put(bytes);
        if (storedHash !== plain) {
          warnings.push(`资产 ${plain} 落库后哈希不一致（${storedHash}），已跳过`);
          continue;
        }
        downloaded += 1;
        bytesSoFar += bytes.length;
        if (mapping[plain] !== candidate.entry.cipher) {
          mapping[plain] = candidate.entry.cipher;
          changed = true;
        }
        break;
      } catch (cause) {
        warnings.push(`资产 ${plain} 下载失败（来自 ${candidate.deviceId}）：${describeError(cause)}`);
      }
    }
  }

  if (noMapping > 0) {
    warnings.push(`有 ${noMapping} 张被卡片引用的图片不在任何远端索引里：可能对端还没同步上传过`);
  }
  if (budgetHit) {
    warnings.push(
      `本次资产下载达到上限（${MAX_ASSET_DOWNLOADS} 个 / ${Math.round(MAX_ASSET_DOWNLOAD_BYTES / 1024 / 1024)}MB），剩余的下次同步继续`,
    );
  }
  return { downloaded, changed };
}

/** 发布本机资产索引（内容有变化或还没有索引时才写）；返回发布的 seq。 */
async function publishIndex(
  input: AssetSyncInput,
  own: PeerIndex | undefined,
  entries: readonly AssetIndexEntry[],
  changed: boolean,
): Promise<number | undefined> {
  const sorted = [...entries].sort((a, b) => a.plain.localeCompare(b.plain));
  // 还没有任何本机资产、也没有旧索引：不必发布空索引（对端读了也没有可用的映射）
  if (sorted.length === 0 && own === undefined) return undefined;
  if (!changed && own !== undefined && sameEntries([...own.entries.values()].sort((a, b) => a.plain.localeCompare(b.plain)), sorted)) {
    return own.seq;
  }
  const storedSeq = Number((await input.device.get(SYNC_ASSET_INDEX_SEQ_KEY)) ?? '0');
  const seq = Math.max(Number.isFinite(storedSeq) ? storedSeq : 0, own?.seq ?? 0) + 1;
  const now = input.now ?? (() => Date.now());
  const encoded = await encodeAssetIndex(
    { v: 1, deviceId: input.deviceId, updatedAt: now(), entries: sorted },
    { ports: input.ports, seq, encrypt: input.ports.cipher !== undefined },
  );
  await input.backend.put(encoded.path, encoded.bytes);
  await input.device.set(SYNC_ASSET_INDEX_SEQ_KEY, String(seq));
  await pruneOwnIndexes(input, seq);
  return seq;
}

export async function syncAssets(input: AssetSyncInput): Promise<AssetSyncSummary> {
  const warnings: string[] = [];
  const client = input.assetClient ?? getAssetClient();
  const mapping = parseMap(await input.device.get(SYNC_ASSET_MAP_KEY));
  const result: AssetSyncSummary = { uploaded: 0, downloaded: 0, skipped: 0, indexSeq: undefined, warnings };
  if (client.kind === 'memory') {
    warnings.push('浏览器内存资产库不持久：本次同步的图片刷新后会丢；可读性以宿主（Tauri）为准');
  }

  let indexes = new Map<string, PeerIndex>();
  try {
    indexes = await readLatestIndexes(input, warnings);
  } catch (cause) {
    warnings.push(`读取远端资产索引失败：${describeError(cause)}`);
  }
  const own = indexes.get(input.deviceId);
  result.indexSeq = own?.seq;

  // 1) 上传：本机资产 → 远端（已同步过的跳过，不重复读字节）
  let localEntries: AssetIndexEntry[] = [];
  try {
    const uploaded = await uploadLocalAssets(input, client, own, mapping, warnings);
    localEntries = uploaded.entries;
    result.uploaded = uploaded.uploaded;
    result.skipped = uploaded.skipped;
    const seq = await publishIndex(input, own, localEntries, uploaded.changed || own === undefined);
    if (seq !== undefined) result.indexSeq = seq;
  } catch (cause) {
    warnings.push(`资产上传失败：${describeError(cause)}`);
  }

  // 2) 下载：只拉当前卡片引用、且本机缺失的资产
  try {
    const localHashes = new Set((await client.list()).filter((hash) => HEX64.test(hash)));
    const downloaded = await downloadRequestedAssets(input, client, indexes, localHashes, mapping, warnings);
    result.downloaded = downloaded.downloaded;
    if (downloaded.changed) {
      // 映射表可能因下载而更新；索引内容没变（本机资产没多）就不必重发
      await input.device.set(SYNC_ASSET_MAP_KEY, JSON.stringify(mapping));
    }
  } catch (cause) {
    warnings.push(`资产下载失败：${describeError(cause)}`);
  }

  try {
    await input.device.set(SYNC_ASSET_MAP_KEY, JSON.stringify(mapping));
  } catch (cause) {
    warnings.push(`资产映射无法持久化（下次会重传）：${describeError(cause)}`);
  }
  return result;
}
