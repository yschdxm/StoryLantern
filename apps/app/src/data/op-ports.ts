import { WireClient, type WireTransport } from '../../../../packages/wire/src/index.ts';
import { ulid } from '../../../../packages/oplog/src/index.ts';
import type { OpLine, OpLogPort, LegacyDump } from './op-repository.ts';
import type { SettingsStore } from './repository.ts';
import { createBrowserKeyValue, createLocalRepository, createMemoryKeyValue, type KeyValueStore } from './local-repository.ts';

/**
 * op 日志与设置的两种实现：Tauri（走 wire → 宿主 SQLite）与浏览器（localStorage）。
 *
 * 两种实现的语义完全一致（同样的 OpLogPort 契约），因此浏览器里也能跑到同样的收敛行为——
 * 这正是"本地优先"该有的样子：没网、没宿主时照样能用，接上同步再合并。
 */

export interface OpPorts {
  ops: OpLogPort;
  settings: SettingsStore;
  loadLegacy?: () => Promise<LegacyDump | undefined>;
}

/** 设备 id：第一次运行时生成并持久化，之后所有 op 都带着它（同步时才知道谁写的）。 */
export async function resolveDeviceId(settings: SettingsStore): Promise<string> {
  const existing = await settings.get('device.id');
  if (existing !== undefined && existing !== '') return existing;
  const fresh = ulid();
  await settings.set('device.id', fresh);
  return fresh;
}

// ---------------------------------------------------------------- Tauri（宿主 SQLite）

export function createWireOpPorts(transport: WireTransport): OpPorts {
  const client = new WireClient(transport);

  return {
    ops: {
      async append(lines) {
        return client.call<{ appended: number; duplicates: number; lastSeq: number }>('oplog', 'append', lines);
      },
      async list(after, limit) {
        return client.call<{ rows: OpLine[]; lastSeq: number }>('oplog', 'list', after, limit);
      },
      async stats() {
        return client.call<{ count: number; lastSeq: number; devices: number; bytes: number }>('oplog', 'stats');
      },
    },
    settings: {
      async get(key) {
        const result = await client.call<{ value: string | null }>('settings', 'get', key);
        return result.value ?? undefined;
      },
      async set(key, value) {
        await client.call<{ saved: boolean }>('settings', 'set', key, value);
      },
      async all() {
        return client.call<Record<string, string>>('settings', 'all');
      },
    },
    loadLegacy: () => client.call<LegacyDump | undefined>('legacy', 'export'),
  };
}

// ---------------------------------------------------------------- 浏览器（localStorage）

interface LocalOpState {
  rows: OpLine[];
  lastSeq: number;
}

const OPS_KEY = 'storylantern.ops.v1';

function loadOpState(store: KeyValueStore): LocalOpState {
  const raw = store.read(OPS_KEY);
  if (raw === undefined || raw === '') return { rows: [], lastSeq: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<LocalOpState>;
    if (!Array.isArray(parsed.rows)) return { rows: [], lastSeq: 0 };
    return { rows: parsed.rows, lastSeq: typeof parsed.lastSeq === 'number' ? parsed.lastSeq : 0 };
  } catch {
    return { rows: [], lastSeq: 0 };
  }
}

export function createLocalOpPorts(store: KeyValueStore = createMemoryKeyValue()): OpPorts {  const state = loadOpState(store);
  const seen = new Set(state.rows.map((row) => row.opId));
  const persist = (): void => store.write(OPS_KEY, JSON.stringify(state));

  // 设置与 op 日志各存一份；设置的语义与宿主 settings 一致（不进 op 日志）
  const settingsRepository = createLocalRepository(store);

  return {
    ops: {
      async append(lines) {
        let appended = 0;
        let duplicates = 0;
        for (const line of lines) {
          const opId = readOpId(line);
          if (opId === '') throw new Error('op 行缺少 opId，拒绝写入');
          if (seen.has(opId)) {
            duplicates += 1;
            continue;
          }
          state.lastSeq += 1;
          state.rows.push({ seq: state.lastSeq, opId, line });
          seen.add(opId);
          appended += 1;
        }
        if (appended > 0) persist();
        return { appended, duplicates, lastSeq: state.lastSeq };
      },
      async list(after, limit) {
        const rows = state.rows.filter((row) => row.seq > after).slice(0, limit);
        return { rows, lastSeq: rows.length === 0 ? after : (rows[rows.length - 1]?.seq ?? after) };
      },
      async stats() {
        const devices = new Set<string>();
        for (const row of state.rows) {
          const device = readDeviceId(row.line);
          if (device !== '') devices.add(device);
        }
        return {
          count: state.rows.length,
          lastSeq: state.lastSeq,
          devices: devices.size,
          bytes: state.rows.reduce((sum, row) => sum + row.line.length, 0),
        };
      },
    },
    settings: settingsRepository.settings,
  };
}

function readOpId(line: string): string {  try {
    const parsed = JSON.parse(line) as { opId?: unknown };
    return typeof parsed.opId === 'string' ? parsed.opId : '';
  } catch {
    return '';
  }
}

function readDeviceId(line: string): string {
  try {
    const parsed = JSON.parse(line) as { deviceId?: unknown };
    return typeof parsed.deviceId === 'string' ? parsed.deviceId : '';
  } catch {
    return '';
  }
}

/**
 * 浏览器里的默认端口：能用 localStorage 就用（刷新不丢数据），
 * 隐私模式下 `setItem` 会抛，那就退回内存——**不能因为存储不可用就白屏**。
 */
export function createDefaultLocalOpPorts(scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>): OpPorts {
  const storage = scope['localStorage'] as Storage | undefined;
  if (storage === undefined) return createLocalOpPorts();
  try {
    const store = createBrowserKeyValue(storage);
    const probeKey = 'storylantern.probe.v1';
    store.write(probeKey, store.read(probeKey) ?? '');
    return createLocalOpPorts(store);
  } catch {
    return createLocalOpPorts();
  }
}
