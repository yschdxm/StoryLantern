import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { messageAppend, sessionCreate, sessionDelete } from '../src/index.ts';
import { Materializer } from '../src/materialize.ts';

/** 会话：创建/改名是同一个 upsert，删除是与写入共用时间线的墓碑。 */

function base(deviceId: string, t = 1_700_000_000_000) {
  return { deviceId, clock: new HlcClock({ now: () => t }) };
}

test('会话 op：创建后可查到，改名走 LWW 且保留创建时间', () => {
  const m = new Materializer();
  const created = sessionCreate(base('A', 1_700_000_000_000), { sessionId: 's1', title: '新会话', characterId: 'c1' });
  m.apply(created);

  assert.equal(m.sessions().length, 1);
  assert.equal(m.sessions()[0]?.title, '新会话');
  assert.equal(m.sessions()[0]?.characterId, 'c1');
  const createdAt = m.sessions()[0]?.createdHlc.t;

  m.apply(sessionCreate(base('A', 1_700_000_100_000), { sessionId: 's1', title: '隘口之夜' }));
  assert.equal(m.sessions()[0]?.title, '隘口之夜');
  assert.equal(m.sessions()[0]?.createdHlc.t, createdAt, '改名不该改变创建时间');
});

test('会话 op：更旧的改名后到会被忽略（乱序收敛）', () => {
  const older = sessionCreate(base('A', 1_700_000_000_000), { sessionId: 's1', title: '旧标题' });
  const newer = sessionCreate(base('B', 1_700_000_100_000), { sessionId: 's1', title: '新标题' });

  const m = new Materializer();
  m.apply(newer);
  m.apply(older);
  assert.equal(m.sessions()[0]?.title, '新标题');

  const m2 = new Materializer();
  m2.applyAll([older, newer]);
  assert.equal(m2.sessions()[0]?.title, '新标题', '两种到达顺序必须收敛到同一结果');
});

test('会话 op：删除是墓碑，更新的改名可以复活', () => {
  const created = sessionCreate(base('A', 1_700_000_000_000), { sessionId: 's1', title: '会话' });
  const removed = sessionDelete(base('A', 1_700_000_100_000), { sessionId: 's1' });
  const revived = sessionCreate(base('B', 1_700_000_200_000), { sessionId: 's1', title: '改名复活' });

  const m = new Materializer();
  m.applyAll([created, removed]);
  assert.deepEqual(m.sessions(), [], '删除后不出现在列表里');

  m.apply(revived);
  assert.equal(m.sessions().length, 1);
  assert.equal(m.sessions()[0]?.title, '改名复活');

  // 更新的写入先到、更旧的删除后到 → 删除被忽略
  const arrival = new Materializer();
  arrival.apply(revived);
  arrival.apply(removed);
  assert.equal(arrival.sessions().length, 1, '更旧的删除不得盖掉更新的写入');
});

test('会话 op：删除一台设备上不存在的会话 → 墓碑让两台设备都收敛到删除', () => {
  const created = sessionCreate(base('A', 1_700_000_000_000), { sessionId: 's1', title: '会话' });
  const removed = sessionDelete(base('B', 1_700_000_100_000), { sessionId: 's1' });

  const deviceB = new Materializer();
  deviceB.apply(removed);
  assert.deepEqual(deviceB.sessions(), []);
  deviceB.apply(created);
  assert.deepEqual(deviceB.sessions(), [], '墓碑比创建新，会话不该复活');
});

test('显式时间戳：导入历史时可以补写过去的 op（消息顺序按补写的时间排）', () => {
  const m = new Materializer();
  const b = base('A', 1_800_000_000_000); // 本机"现在"很晚

  // 两条导入的消息带各自的原始时间：15:00 与 15:10（都在本机现在之前）
  m.apply(
    messageAppend(
      b,
      { sessionId: 's1', messageId: 'm1', author: 'user', content: '先说' },
      { hlc: { t: 1_700_000_000_000, c: 0 } },
    ),
  );
  m.apply(
    messageAppend(
      b,
      { sessionId: 's1', messageId: 'm2', author: 'character', content: '后说' },
      { hlc: { t: 1_700_000_600_000, c: 0 } },
    ),
  );

  const order = m.orderOf('s1').map((message) => m.textOf(message.id));
  assert.deepEqual(order, ['先说', '后说'], '导入的历史按原始时间排序');

  // 再追加一条"现在"的消息，应该排在最后
  m.apply(messageAppend(b, { sessionId: 's1', messageId: 'm3', author: 'user', content: '现在说' }));
  assert.deepEqual(
    m.orderOf('s1').map((message) => m.textOf(message.id)),
    ['先说', '后说', '现在说'],
  );
});
