import { createTauriBridgeFromGlobal, createTauriTransport, WireClient, WireError, type TauriBridge } from '../../../packages/wire/src/index.ts';

/**
 * 宿主面板：把"壳能做什么"显示出来，并给出可操作的验证入口。
 *
 * 这一层刻意与 React 分离（只依赖 `packages/wire`），因为它是**真实逻辑**：
 * 传输选择、错误归因、SQLite 状态、流式的分片与取消。渲染只是把它画出来，
 * 所以它能在 Node 里被测试（注入假桥即可，不需要浏览器或 Android）。
 */

/** 宿主返回的是 snake_case（serde 默认）；边界处显式转换，别把它漏进 UI。 */
export interface HostInfo {
  product: string;
  version: string;
  os: string;
  arch: string;
}

export interface SqliteProbe {
  path: string;
  journalMode: string;
  pageSize: number;
  sqliteVersion: string;
  notes: number;
  writable: boolean;
}

export interface HostNote {
  id: number;
  body: string;
  createdAt: number;
}

export interface StreamChunk {
  index: number;
  text: string;
  /** 元帧（index = -1）：宿主声明本次打算推几片，用于排障与进度显示。 */
  planned?: number;
  charCount?: number;
}

export interface HostViewModel {
  /** 是否运行在宿主（Tauri）里。浏览器里为 false。 */
  available: boolean;
  transport: string;
  methods: string[];
  info?: HostInfo;
  sqlite?: SqliteProbe;
  notes: HostNote[];
  /** 宿主侧事件发射统计：流式排障用（没发出 vs 没送达）。 */
  streamStats?: { ok: number; errors: string[] };
  /** 哪里出了问题：面板要显示出来，而不是留白。 */
  error?: string;
}

export interface StreamResult {
  chunks: number;
  text: string;
  cancelled: boolean;
  /** 宿主声明的分片数（来自元帧）；缺失说明元帧也没到。 */
  planned?: number;
}

export interface HostClient {
  readonly available: boolean;
  readonly transportKind: string;
  describe(): Promise<string[]>;
  load(): Promise<HostViewModel>;
  addNote(body: string): Promise<void>;
  deleteNote(id: number): Promise<void>;
  streamDemo(text: string, onChunk: (chunk: StreamChunk) => void, options?: { signal?: AbortSignal }): Promise<StreamResult>;
}

interface RawProbe {
  path: string;
  journal_mode: string;
  page_size: number;
  sqlite_version: string;
  notes: number;
  writable: boolean;
}

interface RawNote {
  id: number;
  body: string;
  created_at: number;
}

const EMPTY: HostViewModel = { available: false, transport: 'none', methods: [], notes: [] };

function describeError(cause: unknown): string {
  if (cause instanceof WireError) return `${cause.code}：${cause.message}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * 建宿主客户端。
 * - 传 `bridge`（测试用假桥，或自行构造的真桥）；
 * - 不传时探测 `window.__TAURI__`：在 Tauri 里自动可用，在浏览器里明确"不可用"。
 */
export function createHostClient(bridge: TauriBridge | undefined = createTauriBridgeFromGlobal()): HostClient {
  if (bridge === undefined) {
    return {
      available: false,
      transportKind: 'none',
      async describe() {
        return [];
      },
      async load() {
        // 浏览器里没有宿主：这不是错误，面板只需要说清楚这件事
        return EMPTY;
      },
      async addNote() {
        throw new WireError('no-host', '当前不在宿主环境里，无法写入宿主 SQLite');
      },
      async deleteNote() {
        throw new WireError('no-host', '当前不在宿主环境里，无法删除宿主数据');
      },
      async streamDemo() {
        throw new WireError('no-host', '当前不在宿主环境里，没有 IPC 事件通道');
      },
    };
  }

  const transport = createTauriTransport({ bridge });
  const client = new WireClient(transport);

  return {
    available: true,
    transportKind: transport.kind,

    async describe() {
      const manifest = await client.ready();
      if (manifest === undefined) return [];
      return manifest.services.flatMap((service) => service.methods.map((method) => `${service.name}.${method.name} (${method.kind})`));
    },

    async load() {
      const methods = await this.describe().catch(() => [] as string[]);
      try {
        const [info, probe, notes, streamStats] = await Promise.all([
          client.call<HostInfo>('shell', 'info'),
          client.call<RawProbe>('store', 'probe'),
          client.call<RawNote[]>('store', 'listNotes', 20),
          // 统计缺失不算致命：老版本宿主没有这个方法
          client.call<{ ok: number; errors: string[] }>('shell', 'debugStats').catch(() => undefined),
        ]);
        return {
          available: true,
          transport: transport.kind,
          methods,
          info,
          sqlite: {
            path: probe.path,
            journalMode: probe.journal_mode,
            pageSize: probe.page_size,
            sqliteVersion: probe.sqlite_version,
            notes: probe.notes,
            writable: probe.writable,
          },
          notes: notes.map((note) => ({ id: note.id, body: note.body, createdAt: note.created_at })),
          ...(streamStats === undefined ? {} : { streamStats }),
        };
      } catch (cause) {
        return { ...EMPTY, available: true, transport: transport.kind, methods, error: describeError(cause) };
      }
    },

    async addNote(body) {
      await client.call('store', 'addNote', body);
    },

    async deleteNote(id) {
      await client.call('store', 'deleteNote', id);
    },

    async streamDemo(text, onChunk, options = {}) {
      const bound = options.signal === undefined ? client : client.withSignal(options.signal);
      let chunks = 0;
      let collected = '';
      let planned: number | undefined;
      try {
        for await (const chunk of bound.stream<StreamChunk>('shell', 'demoStream', text, 8)) {
          if (typeof chunk.planned === 'number') {
            // 元帧不算数据分片
            planned = chunk.planned;
            onChunk(chunk);
            continue;
          }
          chunks += 1;
          collected += chunk.text;
          onChunk(chunk);
        }
        return { chunks, text: collected, cancelled: false, ...(planned === undefined ? {} : { planned }) };
      } catch (cause) {
        if (cause instanceof WireError && cause.code === 'aborted') {
          return { chunks, text: collected, cancelled: true, ...(planned === undefined ? {} : { planned }) };
        }
        throw cause;
      }
    },
  };
}
