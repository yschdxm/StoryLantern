/**
 * op 日志与迁移相关的类型。
 *
 * 单独一个文件是为了让"端口"（实现）与"仓储"（用法）都能引用它们，
 * 而不用互相 import——循环依赖在 TS 里不报错，但会让打包顺序变得难查。
 */

import type { DeviceStore } from './op-ports.ts';
import type { SettingsStore } from './repository.ts';

export interface OpLine {
  seq: number;
  opId: string;
  line: string;
}

export interface OpLogStats {
  count: number;
  lastSeq: number;
  devices: number;
  bytes: number;
  /** 无法解码而被隔离的行数（不静默丢：界面上能看到）。 */
  corrupt: number;
  /** 上次冷启动走了哪条路（快照 / 全量重放），以及为什么没用快照。 */
  load?: {
    mode: 'snapshot' | 'replay';
    ms: number;
    /** 快照覆盖的 op 条数。 */
    covered: number;
    /** 载入快照后追平的 op 条数。 */
    tail: number;
    /** 快照存在但用不了时的原因。 */
    problem?: string;
  };
}

export interface OpLogPort {
  /** 追加 op 行（JSONL 文本）。按 opId 幂等：重复投递只会计入 duplicates。 */
  append(lines: string[]): Promise<{ appended: number; duplicates: number; lastSeq: number }>;
  /** 按 seq 升序取 `after` 之后的若干行。 */
  list(after: number, limit: number): Promise<{ rows: OpLine[]; lastSeq: number }>;
  stats(): Promise<{ count: number; lastSeq: number; devices: number; bytes: number }>;
}

/** M1 之前的直写表（一次性迁移的输入）。 */
export interface LegacyDump {
  characters: Array<{
    id: number | string;
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    firstMessage?: string;
    exampleDialogue?: string;
    createdAt?: number;
    updatedAt?: number;
  }>;
  sessions: Array<{
    id: number | string;
    title: string;
    characterId: number | string;
    createdAt?: number;
    updatedAt?: number;
  }>;
  messages: Array<{
    id: number | string;
    sessionId: number | string;
    role: string;
    content: string;
    status?: string;
    createdAt?: number;
  }>;
}

/**
 * op 日志仓储的构造参数。放在这里而不是仓储文件里：
 * 它是"调用方需要准备什么"的契约，与端口类型属于同一层。
 */
export interface OpLogRepositoryOptions {
  ops: OpLogPort;
  /** 设备 id：可以直接给，也可以异步解析（首次运行要生成并持久化它）。 */
  deviceId: string | (() => Promise<string>);
  settings: SettingsStore;
  /**
   * 设备本地的小块存储（快照放这里）。不给就**关掉快照**——冷启动回到全量重放，
   * 这样"只想要日志语义"的调用方（测试、浏览器）不必被迫准备一个存储。
   */
  device?: DeviceStore;
  /** 快照启用门槛（日志条数）；不给就用默认值。测试与调参用。 */
  snapshotMinOps?: number;
  /** 日志还是空的且有旧表数据时，用这个把它们转成 op。 */
  loadLegacy?: () => Promise<LegacyDump | undefined>;
  now?: () => number;
}
