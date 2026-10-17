import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateDigest } from '../../../packages/oplog/src/index.ts';
import { createOpLogRepository, type OpLogRepository } from '../src/data/op-repository.ts';
import { createLocalOpPorts, type DeviceStore, type OpPorts } from '../src/data/op-ports.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { SNAPSHOT_KEY } from '../src/data/op-snapshot.ts';

/**
 * 冷启动快照：**它的全部价值就是一个等式**——
 * "载入快照 + 追平尾巴" 得到的物化状态，必须与 "从头重放整份日志" 完全一致。
 * 其余测试都在证明"用不了的时候会老老实实退回全量重放，而不是硬用"。
 */

function makeDevice(): DeviceStore {
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

/** 每次 create 都是一次"冷启动"：同一份 ports + 同一个 device，重开一个仓储。 */
function open(ports: OpPorts, device: DeviceStore, deviceId = 'device-a'): OpLogRepository {
  // 门槛调小：这些用例关心的是机制本身，不是规模（规模另有一份测试）
  return createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId, device, snapshotMinOps: 5 });
}

/** 全量重放（不带 device）——作为"正确答案"的参照物。 */
function replayOnly(ports: OpPorts, deviceId = 'device-a'): OpLogRepository {
  return createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId });
}

async function seed(repo: OpLogRepository): Promise<void> {
  const character = await repo.characters.save({ name: '星野', description: '夜巡的守望者' });
  const session = await repo.sessions.create(character.id, '旅人与星野');
  await repo.messages.append(session.id, 'user', '你听见铜铃了吗');
  await repo.messages.append(session.id, 'assistant', '风从北面来。');
  await repo.memories.save({ characterId: character.id, text: '星野怕水。', keys: ['水'], importance: 80 });
  await repo.lorebooks.save({ name: '星野的世界' });
}

test('快照：载入快照 + 追平尾巴 == 全量重放（状态摘要一致）', async () => {
  const ports = createLocalOpPorts();
  const device = makeDevice();

  const first = open(ports, device);
  await seed(first);
  const created = await first.createSnapshot();
  assert.ok(created.opCount >= 6, '快照应该覆盖已经写进去的 op');
  assert.match(created.digest, /^[0-9a-f]{8}-\d+$/, '摘要是 CRC32-长度');

  // 冷启动：应当走快照
  const second = open(ports, device);
  await second.ready;
  const stats = await second.logStats();
  assert.equal(stats.load?.mode, 'snapshot');
  assert.equal(stats.load?.tail, 0, '快照之后还没有新 op');
  assert.equal(stats.load?.problem, undefined);

  // 正确答案：全量重放
  const reference = replayOnly(ports);
  await reference.ready;
  assert.equal(stateDigest(second.currentMaterializer().state), stateDigest(reference.currentMaterializer().state));
});

test('快照：快照之后写入的 op 会被追平（tail > 0），状态依然一致', async () => {
  const ports = createLocalOpPorts();
  const device = makeDevice();

  const first = open(ports, device);
  await seed(first);
  await first.createSnapshot();

  // 快照之后继续写
  const session = (await first.sessions.list())[0];
  assert.ok(session !== undefined);
  await first.messages.append(session.id, 'user', '快照之后的这句也必须还在');
  await first.memories.save({ text: '铜铃是报信之物。', keys: ['铜铃'], importance: 70 });

  const second = open(ports, device);
  await second.ready;
  const stats = await second.logStats();
  assert.equal(stats.load?.mode, 'snapshot');
  assert.ok((stats.load?.tail ?? 0) > 0, '应当追平了尾巴');

  const reference = replayOnly(ports);
  await reference.ready;
  assert.equal(
    stateDigest(second.currentMaterializer().state),
    stateDigest(reference.currentMaterializer().state),
    '快照路径与全量重放必须得到同一个状态',
  );
});

test('快照：日志里留了一条检查点，且它不改变状态、日志没有被截断', async () => {
  const ports = createLocalOpPorts();
  const device = makeDevice();

  const repo = open(ports, device);
  await seed(repo);
  const before = await repo.logStats();
  const created = await repo.createSnapshot();
  const after = await repo.logStats();

  assert.equal(after.count, before.count + 1, '只多了一条检查点 op；日志没有被截断');
  assert.equal(after.lastSeq, before.lastSeq + 1);
  assert.ok(after.load !== undefined);

  // 检查点 op 不改变状态：全量重放（含检查点）与快照路径一致。
  // 注意：ready 会跑一次卡片模型迁移（ADR-0011，旧角色 → card.upsert）；两边都要走一次 ready，
  // 否则一边有迁移出的卡片、一边没有，摘要必然不同——那比较的就不是快照机制了。
  const snapshotPath = open(ports, device);
  await snapshotPath.ready;
  const reference = replayOnly(ports);
  await reference.ready;
  assert.equal(stateDigest(snapshotPath.currentMaterializer().state), stateDigest(reference.currentMaterializer().state));
  assert.equal(created.lastSeq, after.lastSeq, '快照覆盖到检查点为止');
});

test('快照：内容被改花时退回全量重放，并如实说明原因（不静默）', async () => {
  const ports = createLocalOpPorts();
  const device = makeDevice();

  const first = open(ports, device);
  await seed(first);
  await first.createSnapshot();

  // 破坏快照体：改一个字段，摘要就对不上了
  const raw = await device.get(SNAPSHOT_KEY);
  assert.ok(raw !== undefined && raw !== '');
  const tampered = raw.replace('"星野"', '"被改过的名字"');
  await device.set(SNAPSHOT_KEY, tampered);

  const second = open(ports, device);
  await second.ready;
  const stats = await second.logStats();
  assert.equal(stats.load?.mode, 'replay', '坏快照必须被拒绝');
  assert.match(stats.load?.problem ?? '', /快照/);

  // 而且数据是对的（退回全量重放）
  const reference = replayOnly(ports);
  await reference.ready;
  assert.equal(stateDigest(second.currentMaterializer().state), stateDigest(reference.currentMaterializer().state));
  assert.equal((await second.characters.list())[0]?.name, '星野');
});

test('快照：完全不是 JSON 时也一样退回全量重放', async () => {
  const ports = createLocalOpPorts();
  const device = makeDevice();
  const first = open(ports, device);
  await seed(first);
  await first.createSnapshot();
  await device.set(SNAPSHOT_KEY, '{这不是 JSON');

  const second = open(ports, device);
  await second.ready;
  assert.equal((await second.logStats()).load?.mode, 'replay');
  assert.equal((await second.characters.list()).length, 1);
});

test('快照：日志被重建/换掉（锚点对不上）时退回全量重放，绝不错用', async () => {
  const ports = createLocalOpPorts();
  const device = makeDevice();
  const first = open(ports, device);
  await seed(first);
  await first.createSnapshot();

  // 模拟"日志被换成了另一段"：新的空 ports，但设备上还留着旧快照
  const fresh = createLocalOpPorts();
  const second = open(fresh, device);
  await second.ready;
  const stats = await second.logStats();
  assert.equal(stats.load?.mode, 'replay');
  assert.match(stats.load?.problem ?? '', /日志|快照/);
  assert.equal((await second.characters.list()).length, 0, '空日志就是空状态，不能被旧快照污染');
});

test('快照：没有设备存储时明确关掉快照（而不是假装有）', async () => {
  const ports = createLocalOpPorts();
  const repo = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repo.ready;
  const stats = await repo.logStats();
  assert.equal(stats.load?.mode, 'replay');
  assert.match(stats.load?.problem ?? '', /没有设备本地存储/);
  await assert.rejects(
    () => repo.createSnapshot(),
    (error: unknown) => (error as Error).message.includes('没有设备本地存储'),
  );
});

test('快照：清掉之后回到全量重放，状态不变', async () => {
  const ports = createLocalOpPorts();
  const device = makeDevice();
  const first = open(ports, device);
  await seed(first);
  await first.createSnapshot();
  await first.clearSnapshot();

  const second = open(ports, device);
  await second.ready;
  const stats = await second.logStats();
  assert.equal(stats.load?.mode, 'replay');
  assert.equal(stats.load?.problem, undefined, '没有快照不算"出问题"');

  const reference = replayOnly(ports);
  await reference.ready;
  assert.equal(stateDigest(second.currentMaterializer().state), stateDigest(reference.currentMaterializer().state));
});

test('快照：空日志不生成快照（没有可锚定的位置）', async () => {
  const ports = createLocalOpPorts();
  const device = makeDevice();
  const repo = open(ports, device);
  await repo.ready;
  await assert.rejects(
    () => repo.createSnapshot(),
    (error: unknown) => (error as Error).message.includes('空'),
  );
});
