/**
 * @storylantern/oplog —— 变更日志协议层。
 *
 * 这是整个同步体系的正确性地基：段必须自校验、可幂等重放、且与到达顺序无关。
 */
export {
  blindId,
  compareUlid,
  concatBytes,
  fromBase64,
  fromBase64Url,
  fromHex,
  fromUtf8,
  isUlid,
  toBase64,
  toBase64Url,
  toHex,
  ulid,
  utf8,
} from './bytes.ts';
export { crc32, crc32Hex } from './crc32.ts';
export { compareHlc, compareOpOrder, hlcSortKey, HlcClock, type Hlc, type HlcClockOptions } from './hlc.ts';
export {
  candidateAppend,
  candidateSelect,
  characterDelete,
  characterUpsert,
  createOp,
  decodeOp,
  decodeOps,
  encodeOp,
  encodeOps,
  isOp,
  messageAppend,
  messageDelete,
  messageEdit,
  OP_SCHEMA_VERSION,
  OpCodecError,
  revisionSelect,
  sessionCreate,
  sessionDelete,
  settingSet,
  type CandidateAppendPayload,
  type CandidateSelectPayload,
  type CharacterDeletePayload,
  type CharacterUpsertPayload,
  type CreateOpOptions,
  type MessageAppendPayload,
  type MessageAuthor,
  type MessageDeletePayload,
  type MessageEditPayload,
  type Op,
  type OpType,
  type RevisionSelectPayload,
  type SessionCreatePayload,
  type SessionDeletePayload,
  type SettingSetPayload,
  type StampOptions,
} from './op.ts';
export {
  loreEntryDelete,
  loreEntryUpsert,
  lorebookDelete,
  lorebookUpsert,
  type LoreEntryDeletePayload,
  type LoreEntryUpsertPayload,
  type LorebookDeletePayload,
  type LorebookUpsertPayload,
} from './lore-ops.ts';
export { listLorebooks, listLoreEntries } from './lorebook-projection.ts';
export { listMemories, memoriesFor } from './memory-projection.ts';
export {
  SnapshotBlobError,
  canonicalJson,
  checkpointOp,
  stateDigest,
  validateStateSnapshot,
  type CheckpointPayload,
  type CheckpointRecord,
  type StateSnapshot,
} from './checkpoint.ts';
export {
  memoryDelete,
  memoryUpsert,
  type MemoryAuthor,
  type MemoryDeletePayload,
  type MemoryUpsertPayload,
} from './memory-ops.ts';
export {
  summaryDelete,
  summaryUpsert,
  type SummaryDeletePayload,
  type SummaryLevel,
  type SummaryUpsertPayload,
} from './summary-ops.ts';
export {
  applySummaryDelete,
  applySummaryUpsert,
  listSummaries,
} from './summary-projection.ts';
export {
  DEFAULT_ARC_SIZE,
  DEFAULT_SCENE_SIZE,
  countUnits,
  planSummaries,
  staleSummaries,
  summaryIdOf,
  type SummaryMessage,
  type SummaryPlanInput,
  type SummaryRecordLike,
  type SummaryTarget,
} from './summary-plan.ts';
export {
  runSummaries,
  runSummariesFor,
  type SummarizeRequest,
  type SummaryRunInput,
  type SummaryRunResult,
  type SummaryRunnerOptions,
} from './summary-runner.ts';
export {
  cosineSimilarity,
  createHashEmbeddingStub,
  reciprocalRankFusion,
  retrieveHybrid,
  vectorSearch,
  type EmbeddingPort,
  type HybridRetrieveOptions,
  type HybridRetrieveResult,
  type RetrievalMode,
} from './retrieval-hybrid.ts';
export {
  retrieve,
  tokenize,
  type RetrieveOptions,
  type RetrievalDoc,
  type RetrievalKind,
  type ScoredDoc,
} from './retrieval.ts';
export {
  computeUsage,
  priceOf,
  totalUsage,
  withinBudget,
  wouldExceed,
  type BudgetState,
  type ModelPrice,
  type UsageRecord,
  type UsageSlice,
  type UsageTask,
  type UsageTotals,
} from './usage.ts';
export {
  factDelete,
  factUpsert,
  type FactAuthor,
  type FactDeletePayload,
  type FactState,
  type FactUpsertPayload,
} from './fact-ops.ts';
export { applyFactDelete, applyFactUpsert, listFacts } from './fact-projection.ts';
export {
  conflictsOf,
  factsToLoreEntries,
  parseFactProposals,
  provenanceLine,
  type ExportFactsOptions,
  type FactConflict,
  type FactProposal,
  type LoreEntryDraft,
  type ParseFactsResult,
} from './fact-logic.ts';
export type { FactRecord, SummaryRecord } from './state-types.ts';
export {
  Materializer,
  type CandidateRecord,
  type CharacterRecord,
  type ForkGroup,
  type LoreEntryRecord,
  type LorebookRecord,
  type MaterializedState,
  type MemoryRecord,
  type MessageRecord,
  type RevisionRecord,
  type SessionRecord,
  type Snapshot,
} from './materialize.ts';
export { SnapshotError, validateSessionSnapshot, type SessionSnapshot } from './snapshot.ts';
export { freezeSnapshot } from './freeze.ts';
export type {
  Compressor,
  CryptoPorts,
  Digest,
  SealedPayload,
  SegmentCipher,
  SegmentSigner,
  SignatureVerifier,
} from './ports.ts';
export {
  estimateOpBytes,
  packSegment,
  parseSegmentFileName,
  peekSegment,
  segmentFileName,
  SEGMENT_FORMAT_VERSION,
  SEGMENT_MAGIC,
  SEGMENT_POLICY,
  SegmentError,
  shouldFlush,
  signaturePayload,
  unpackSegment,
  type PackSegmentInput,
  type PackedSegment,
  type SegmentErrorCode,
  type SegmentHeader,
  type SegmentTrailer,
  type UnpackExpectations,
  type UnpackedSegment,
} from './segment.ts';
export {
  createAesGcmCipher,
  createDeviceSigner,
  createRosterVerifier,
  generateDeviceKeyPair,
  nodeDigest,
  nodeGzip,
  type AesGcmOptions,
  type DeviceKeyPair,
  type DeviceRoster,
} from './node-adapters.ts';
