import { HlcClock } from '../../oplog/src/hlc.ts';
import { Materializer } from '../../oplog/src/materialize.ts';
import { createAesGcmCipher, nodeDigest, nodeGzip } from '../../oplog/src/node-adapters.ts';
import type { Op } from '../../oplog/src/op.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import { createMemoryBackend, type MemoryBackend, type MemoryBackendOptions } from '../../../plugins/sync-memory/src/index.ts';
import { SyncEngine, type SyncResult } from '../src/engine.ts';
import { DeviceRosterList, type DeviceRecord } from '../src/roster.ts';

export interface Peer {
  deviceId: string;
  engine: SyncEngine;
  materializer: Materializer;
  clock: HlcClock;
  setWallClock(ms: number): void;
}

export interface World {
  backend: MemoryBackend;
  blindKey: Uint8Array;
  roster: DeviceRosterList;
  peers: Map<string, Peer>;
  peer(deviceId: string): Peer;
  sync(deviceId: string): Promise<SyncResult>;
  /** 所有设备两两同步到不再产生新 op（模拟"大家都上线了"）。 */
  settle(): Promise<void>;
}

const BASE_TIME = 1_700_000_000_000;

export interface WorldOptions {
  deviceIds?: string[];
  backend?: Partial<MemoryBackendOptions>;
  /** 每台设备的墙上时钟偏移（毫秒），用来复现时钟漂移。 */
  clockOffsets?: Record<string, number>;
  graceMs?: number;
  /** 累积多少段后自动写快照（默认 8）。 */
  snapshotThreshold?: number;
  /** 懒加载过滤器：返回 false 的会话本轮不拉。 */
  shouldPull?: (blindSessionId: string) => boolean;
}

export function createWorld(options: WorldOptions = {}): World {
  const deviceIds = options.deviceIds ?? ['device-a', 'device-b'];
  const blindKey = new Uint8Array(32).fill(7);
  const cipher = createAesGcmCipher({ key: new Uint8Array(32).fill(9) });
  const backend = createMemoryBackend(options.backend ?? {});

  const records: DeviceRecord[] = deviceIds.map((deviceId, index) => ({ deviceId, addedAt: BASE_TIME + index }));
  const roster = new DeviceRosterList(records);

  const peers = new Map<string, Peer>();
  for (const deviceId of deviceIds) {
    let wall = BASE_TIME + (options.clockOffsets?.[deviceId] ?? 0);
    const clock = new HlcClock({ now: () => wall });

    const ports: CryptoPorts = {
      digest: nodeDigest,
      compressor: nodeGzip,
      cipher,
    };

    const engine = new SyncEngine({
      deviceId,
      backend,
      ports,
      roster,
      blindKey,
      clock,
      now: () => wall,
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      ...(options.snapshotThreshold === undefined ? {} : { snapshotThreshold: options.snapshotThreshold }),
      ...(options.shouldPull === undefined ? {} : { shouldPull: options.shouldPull }),
    });

    peers.set(deviceId, {
      deviceId,
      engine,
      materializer: new Materializer(),
      clock,
      setWallClock(ms: number) {
        wall = ms;
      },
    });
  }

  const world: World = {
    backend,
    blindKey,
    roster,
    peers,
    peer(deviceId: string): Peer {
      const peer = peers.get(deviceId);
      if (!peer) throw new Error(`未知设备 ${deviceId}`);
      return peer;
    },
    async sync(deviceId: string): Promise<SyncResult> {
      const peer = world.peer(deviceId);
      return peer.engine.sync(peer.materializer);
    },
    async settle(): Promise<void> {
      for (let round = 0; round < 4; round += 1) {
        for (const deviceId of peers.keys()) await world.sync(deviceId);
      }
    },
  };

  return world;
}

/** 把 op 同时记进本地 outbox（真实场景由本地写操作产生）。 */
export function emit(peer: Peer, op: Op): Op {
  peer.engine.enqueue(op);
  peer.materializer.applyAll([op]);
  return op;
}

export function freeze(peer: Peer): string {
  return Materializer.freeze(peer.materializer.snapshot());
}

export function messageIds(peer: Peer, sessionId = 'S1'): string[] {
  return peer.materializer.orderOf(sessionId).map((message) => message.id);
}
