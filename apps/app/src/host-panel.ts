import { createTauriBridgeFromGlobal, createTauriTransport, WireClient, WireError, type TauriBridge } from '../../../packages/wire/src/index.ts';

/**
 * 宿主客户端：对界面的唯一入口。
 *
 * 界面**不直接知道**自己是跑在 Tauri 里还是浏览器里——这一层负责选传输、
 * 把宿主返回的 snake_case 转成界面用的形状、并把错误变成可读文案。
 */

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
  writable: boolean;
  characters: number;
  sessions: number;
  messages: number;
}

export interface StreamChunk {
  index: number;
  text: string;
}

export interface HostViewModel {
  available: boolean;
  transport: string;
  methods: string[];
  info?: HostInfo;
  sqlite?: SqliteProbe;
  streamStats?: { ok: number; errors: string[] };
  error?: string;
}

export interface StreamResult {
  chunks: number;
  text: string;
  cancelled: boolean;
}

export interface HostClient {
  readonly available: boolean;
  readonly transportKind: string;
  describe(): Promise<string[]>;
  load(): Promise<HostViewModel>;
  streamDemo(text: string, onChunk: (chunk: StreamChunk) => void, options?: { signal?: AbortSignal }): Promise<StreamResult>;
}

interface RawProbe {
  path: string;
  journalMode: string;
  pageSize: number;
  sqliteVersion: string;
  writable: boolean;
  characters: number;
  sessions: number;
  messages: number;
}

const EMPTY: HostViewModel = { available: false, transport: 'none', methods: [] };

function describeError(cause: unknown): string {
  if (cause instanceof WireError) return `${cause.code}：${cause.message}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

export function createHostClient(bridge: TauriBridge | undefined = createTauriBridgeFromGlobal()): HostClient {
  if (bridge === undefined) {
    return {
      available: false,
      transportKind: 'none',
      async describe() {
        return [];
      },
      async load() {
        return EMPTY;
      },
      async streamDemo() {
        throw new WireError('no-host', '当前不在宿主环境里，没有 IPC 通道');
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
      return manifest.services.flatMap((service) =>
        service.methods.map((method) => `${service.name}.${method.name} (${method.kind})`),
      );
    },

    async load() {
      const methods = await this.describe().catch(() => [] as string[]);
      try {
        const [info, probe, streamStats] = await Promise.all([
          client.call<HostInfo>('shell', 'info'),
          client.call<RawProbe>('store', 'probe'),
          client.call<{ ok: number; errors: string[] }>('shell', 'debugStats').catch(() => undefined),
        ]);
        return {
          available: true,
          transport: transport.kind,
          methods,
          info,
          // 宿主已经按 camelCase 出参（Rust 侧 serde(rename_all)），这里不再做字段翻译
          sqlite: probe,
          ...(streamStats === undefined ? {} : { streamStats }),
        };
      } catch (cause) {
        return { ...EMPTY, available: true, transport: transport.kind, methods, error: describeError(cause) };
      }
    },

    async streamDemo(text, onChunk, options = {}) {
      const bound = options.signal === undefined ? client : client.withSignal(options.signal);
      let chunks = 0;
      let collected = '';
      try {
        for await (const chunk of bound.stream<StreamChunk>('shell', 'demoStream', text, 8)) {
          if (chunk.text === '') continue;
          chunks += 1;
          collected += chunk.text;
          onChunk(chunk);
        }
        return { chunks, text: collected, cancelled: false };
      } catch (cause) {
        if (cause instanceof WireError && cause.code === 'aborted') {
          return { chunks, text: collected, cancelled: true };
        }
        throw cause;
      }
    },
  };
}
