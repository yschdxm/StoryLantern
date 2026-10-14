import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock, encodeOp, messageAppend, sessionCreate, stateDigest } from '../../../packages/oplog/src/index.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createLocalOpPorts, type DeviceStore, type OpPorts } from '../src/data/op-ports.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { SNAPSHOT_MIN_OPS } from '../src/data/op-snapshot.ts';

/**
 * 快照的机制价值只在**规模**上体现：小日志下它反而更慢（多两次 IPC 往返，
 * 真机实测 48 条时 197 ms vs 37 ms），所以有启用门槛。
 *
 * 这里不用"计时"证明（会很脆），而是数**启动时需要读/解码多少 op**：
 * 全量重放必须读完整份日志，快照路径只读锚点 + 尾巴。
 */

const clock = new HlcClock({ now: () => 2_000 });

async function makeDevice(): Promise<DeviceStore> {
  const store = createMemoryKeyValue();
  return {
    async get(key) {
      return store.read(key);
    },
    async set(key, value) {
      store.write(key, value);
    },
  };
}

/** 造一份大日志：1 条建会话 + N 条消息，直接用 op 端口写进去（不走仓储，省时间）。 */
async function bigLog(ports: OpPorts, count: number): Promise<{ appends: number }> {
  const base = { deviceId: 'device-a', clock };
  const lines: string[] = [
    encodeOp(sessionCreate(base, { sessionId: 'session-big', characterId: 'char-1', title: '大日志' })),
  ];
  for (let index = 0; index < count; index += 1) {
    lines.push(
      encodeOp(messageAppend(base, { sessionId: 'session-big', messageId: `m-${index}`, author: 'user', content: `第 ${index} 句` })),
    );
  }
  await ports.ops.append(lines);
  return { appends: lines.length };
}

/** 包一层端口，数一数"读回来多少行"——这正是冷启动要付的代价。 */
function counting(ports: OpPorts): { ports: OpPorts; read: () => number } {
  let rows = 0;
  const wrapped: OpPorts = {
    ...ports,
    ops: {
      append: (lines) => ports.ops.append(lines),
      stats: () => ports.ops.stats(),
      list: async (after, limit) => {
        const page = await ports.ops.list(after, limit);
        rows += page.rows.length;
        return page;
      },
    },
  };
  return { ports: wrapped, read: () => rows };
}

test(`快照：日志超过 ${SNAPSHOT_MIN_OPS} 条时，启动读的 op 数量从"全量"降到"锚点+尾巴"`, async () => {
  const raw = createLocalOpPorts();
  const { appends } = await bigLog(raw, SNAPSHOT_MIN_OPS + 500);
  const device = await makeDevice();

  // 先生成快照（此时日志已经够大）
  const builder = createOpLogRepository({ ops: raw.ops, settings: raw.settings, deviceId: 'device-a', device });
  await builder.ready;
  await builder.createSnapshot();

  // 之后又写了 3 条：快照路径必须追平它们
  await bigLog(raw, 3);

  const { ports: counted, read } = counting(raw);
  const fast = createOpLogRepository({ ops: counted.ops, settings: counted.settings, deviceId: 'device-a', device });
  await fast.ready;
  const stats = await fast.logStats();
  const readForSnapshot = read();

  const reference = createOpLogRepository({ ops: raw.ops, settings: raw.settings, deviceId: 'device-a' });
  await reference.ready;

  assert.equal(stats.load?.mode, 'snapshot', '够大就该走快照');
  assert.ok(readForSnapshot <= 10, `快照路径应当只读极少数 op，实际读了 ${readForSnapshot}`);
  assert.ok(readForSnapshot < appends / 100, '与全量重放不是一个量级');
  assert.equal(
    stateDigest(fast.currentMaterializer().state),
    stateDigest(reference.currentMaterializer().state),
    '少读不等于少结果：状态必须与全量重放一致',
  );
});

test('快照：日志小于门槛时，即使有快照也如实说明"全量重放更快"', async () => {
  const ports = createLocalOpPorts();
  const device = await makeDevice();

  // 先造一份够大的日志、生成快照，再把日志换小（模拟"快照还在但日志已经不大了"）
  const bigPorts = createLocalOpPorts();
  await bigLog(bigPorts, SNAPSHOT_MIN_OPS + 10);
  const builder = createOpLogRepository({ ops: bigPorts.ops, settings: bigPorts.settings, deviceId: 'device-a', device });
  await builder.ready;
  await builder.createSnapshot();

  // 小日志 + 旧快照：锚点对不上 → 门槛与锚点都应该拦住它
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a', device });
  await repo.ready;
  const stats = await repo.logStats();
  assert.equal(stats.load?.mode, 'replay');
  assert.ok((stats.load?.problem ?? '') !== '');

  // 小日志下也不该让人生成快照：直接说清为什么
  await assert.rejects(
    () => repo.createSnapshot(),
    (error: unknown) => /小|空/.test((error as Error).message),
  );
});
