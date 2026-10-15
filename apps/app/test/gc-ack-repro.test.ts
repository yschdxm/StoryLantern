import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDevice, createMemoryBackend, loadSyncState } from './sync-harness.ts';
import { safeThroughSeq } from '../../../packages/sync-core/src/roster.ts';

/**
 * ⑤ 的确定性复现：**"已并入"必须逐环反映到 ack 里**，否则 GC 永远算 0、永远没有可回收段。
 *
 * 真机现象（手机 + 模拟器两台，都显示「刚刚」）：模拟器明明已经并入了手机的内容
 * （它界面上有那 1 个角色 1 个会话），可手机算出的 `safeThrough` 还是 0，
 * 于是两段都报「尚有设备未并入（safeThrough=0）」，回收按钮根本出不来。
 *
 * 这条测试把链路上三个环节分开钉住，哪个是 0 就明明白白报出来：
 *   ① B 自己有没有记下"我已并入 A 到第几段"（B 的 `ack[A]`）；
 *   ② A 再同步读 B 的清单后，`peerAck[B][A]` 是不是那个值；
 *   ③ 用与 `gc.ts` **同一个** `safeThroughSeq` 与同一份输入形状，算出来的值是不是 ≥1。
 */

test('⑤ 复现：B 并入 A 的内容后，ack 必须逐环反映（否则 GC 永远算 0）', async () => {
  const backend = createMemoryBackend();
  const secret = 'shared secret';
  const a = await createDevice('device-a', backend, secret);
  const b = await createDevice('device-b', backend, secret);

  // A：造内容并发布
  const character = await a.repository.characters.save({ name: '星野', firstMessage: '「进来吧。」' });
  await a.repository.sessions.create(character.id, '隘口之夜');
  const first = await a.sync();
  assert.ok(first.uploaded > 0, 'A 应当把段推上去');

  // B：并入（`sync()` 会自己补一轮加入流程）
  const second = await b.sync();
  assert.ok(second.downloaded > 0, 'B 应当拉到段');
  assert.deepEqual((await b.repository.characters.list()).map((item) => item.name), ['星野'], 'B 真的并入了内容');

  // ① B 自己的 ack
  const bState = await loadSyncState(b);
  assert.ok(
    (bState.ack['device-a'] ?? 0) >= 1,
    `① B 的 ack[device-a] 应当 >=1（B 确实并入了 A 的段），实际 ${JSON.stringify(bState.ack)}`,
  );

  // ② A 反复同步，每轮都打印"B 清单里声明的并入进度"，看是滞后一轮还是永远为空
  const rounds: Array<{ round: number; declared: number | undefined; ack: Record<string, number> }> = [];
  for (let round = 1; round <= 3; round += 1) {
    await a.sync();
    const state = await loadSyncState(a);
    const declared = state.peerAck['device-b']?.['device-a'];
    rounds.push({ round, declared, ack: state.ack });
    console.log(
      `  [A 第 ${round} 轮同步] peerAck[device-b]=${JSON.stringify(state.peerAck['device-b'] ?? null)}  ack(A 自己)=${JSON.stringify(state.ack)}`,
    );
  }
  const last = rounds[rounds.length - 1];
  assert.ok(
    (last?.declared ?? 0) >= 1,
    `② A 眼里 B 声明的并入进度应当 >=1（来自 B 清单的 ack），实际 peerAck=${JSON.stringify(rounds.map((item) => item.declared))}`,
  );

  // ③ 与 gc.ts 完全同一份输入形状与同一个函数
  const active = ['device-a', 'device-b'];
  const aState = await loadSyncState(a);
  const sources = [
    { deviceId: 'device-a', ack: aState.ack },
    ...Object.entries(aState.peerAck).map(([id, ack]) => ({ deviceId: id, ack })),
  ];
  const through = safeThroughSeq(sources, active, 'device-a');
  assert.ok(through >= 1, `③ safeThrough 应当 >=1，实际 ${through}`);
});

test('⑤ 复现：本机发布过段之后，分析必须给出候选或原因（绝不能两者皆空）', async () => {
  const backend = createMemoryBackend();
  const secret = 'shared secret';
  const a = await createDevice('device-a', backend, secret);
  const character = await a.repository.characters.save({ name: '星野', firstMessage: '「进来吧。」' });
  await a.repository.sessions.create(character.id, '隘口之夜');
  const first = await a.sync();
  assert.ok(first.uploaded > 0, 'A 应当把段推上去');

  const report = await a.service.collect(true);
  console.log(
    `  [A 自己分析] candidates=${report.candidates.length} reasons=${report.reasons.length} reasons[0]=${report.reasons[0] ?? '(无)'}`,
  );
  assert.ok(
    report.candidates.length + report.reasons.length >= 1,
    `本机明明发布过段，分析却什么都没说：candidates=${JSON.stringify(report.candidates)} reasons=${JSON.stringify(report.reasons)}`,
  );
});
﻿
test('⑤ 宽限期可调：填 0 时应当真的出现可回收段，并且能执行回收（dryRun 绝不删）', async () => {
  const backend = createMemoryBackend();
  const secret = 'shared secret';
  const a = await createDevice('device-a', backend, secret, { graceMs: 0 });
  const character = await a.repository.characters.save({ name: '星野', firstMessage: '「进来吧。」' });
  await a.repository.sessions.create(character.id, '隘口之夜');
  await a.sync();

  const dry = await a.service.collect(true);
  console.log('  [宽限期 0 · 只分析] candidates=' + dry.candidates.length + ' moved=' + dry.moved.length);
  assert.ok(dry.candidates.length >= 1, '宽限期为 0 时应当至少有一个可回收段，实际 ' + JSON.stringify(dry));
  assert.equal(dry.moved.length, 0, 'dryRun 绝不能真的删东西');

  const real = await a.service.collect(false);
  console.log('  [宽限期 0 · 真回收] candidates=' + real.candidates.length + ' moved=' + real.moved.length);
  assert.ok(real.moved.length >= 1, '应当真的把段移进 trash，实际 ' + JSON.stringify(real));
});
﻿
test('⑤ 复现（后加入者路径）：加入已有库之后再发布自己的段，分析必须能看见它们', async () => {
  const backend = createMemoryBackend();
  const secret = 'shared secret';
  const a = await createDevice('device-a', backend, secret, { graceMs: 0 });
  const b = await createDevice('device-b', backend, secret, { graceMs: 0 });

  // A 建库并发布内容
  const character = await a.repository.characters.save({ name: '星野', firstMessage: '「进来吧。」' });
  await a.repository.sessions.create(character.id, '隘口之夜');
  await a.sync();

  // B 加入（sync() 会自动补一轮"等被接纳"）并同步
  const joined = await b.sync();
  console.log('  [B 加入并同步] downloaded=' + joined.downloaded + ' warnings=' + joined.warnings.length);

  // B 自己造内容并发布
  const own = await b.repository.characters.save({ name: 'B 的角色' });
  await b.repository.sessions.create(own.id, 'B 的会话');
  const published = await b.sync();
  console.log('  [B 发布自己的段] uploaded=' + published.uploaded);

  const state = await loadSyncState(b);
  const hostedBlindCount = Object.keys((await b.store.load()).state?.hosted ?? {}).length;
  console.log('  [B 本地状态] ack=' + JSON.stringify(state.ack) + ' hosted 会话数=' + hostedBlindCount);

  const report = await b.service.collect(true);
  console.log(
    '  [B 自己分析] candidates=' + report.candidates.length + ' reasons=' + report.reasons.length + ' reasons[0]=' + (report.reasons[0] ?? '(无)'),
  );
  assert.ok(
    report.candidates.length + report.reasons.length >= 1,
    'B 自己发布过段，分析却什么都没说：candidates=' + JSON.stringify(report.candidates) + ' reasons=' + JSON.stringify(report.reasons),
  );
});
