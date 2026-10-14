/**
 * op 日志与迁移相关的类型。
 *
 * 单独一个文件是为了让"端口"（实现）与"仓储"（用法）都能引用它们，
 * 而不用互相 import——循环依赖在 TS 里不报错，但会让打包顺序变得难查。
 */

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
