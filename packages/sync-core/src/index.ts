/**
 * @storyforge/sync-core —— 本地优先同步引擎。
 *
 * 设计约束（见 docs/PLAN.md §8）：
 *  - 远端不存在"共享可变状态"：每台设备只写自己的命名空间，且文件名含内容摘要；
 *  - 发现只读 manifest，**从不遍历 logs/ 目录树**；
 *  - 段自带校验与签名，任何一步失败都整体拒绝；
 *  - 远端回滚/缺段只告警，绝不回退本地；
 *  - GC 默认保守：名单内全部活跃设备确认 + 宽限期 + 先进 trash。
 */
export {
  instrumentBackend,
  type BackendCallCounters,
  type BackendCapabilities,
  type BackendEntry,
  type InstrumentedBackend,
  type ListOptions,
  type ListResult,
  type PutResult,
  type SyncBackend,
} from './backend.ts';
export {
  ASSETS_PREFIX,
  assetPath,
  DEVICES_PREFIX,
  LOGS_PREFIX,
  manifestFileName,
  manifestPath,
  manifestPrefix,
  parseManifestFileName,
  parseSegmentPath,
  ROOT_PREFIX,
  segmentPath,
  segmentPrefix,
  SNAPSHOTS_PREFIX,
  snapshotPath,
  snapshotPrefix,
  TRASH_PREFIX,
  trashPath,
} from './paths.ts';
export {
  decodeManifest,
  encodeManifest,
  GLOBAL_SESSION,
  sessionIdOf,
  type EncodedManifest,
  type Manifest,
  type SessionRef,
} from './manifest.ts';
export {
  decideCollection,
  DeviceRosterList,
  safeThroughSeq,
  type AckSource,
  type CollectionDecision,
  type CollectionInput,
  type DeviceRecord,
} from './roster.ts';
export { SyncEngine, type HostedSession, type LocalSyncState, type SyncEngineOptions, type SyncResult } from './engine.ts';
