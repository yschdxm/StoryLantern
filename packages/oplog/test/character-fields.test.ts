import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { Materializer } from '../src/materialize.ts';
import { characterUpsert } from '../src/op.ts';

const clock = new HlcClock({ now: () => 1_000 });
const base = { deviceId: 'device-a', clock };

/**
 * 角色卡带来的两样东西：自带 system prompt 与备选开场白。
 * 它们必须进 op（否则同步到别的设备就丢了），并且空值要能表达"没设置"。
 */
test('角色：自带 system prompt 与备选开场白进物化状态，空值不落字段', () => {
  const materializer = new Materializer();
  materializer.apply(
    characterUpsert(base, {
      characterId: 'c1',
      name: '星野',
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '「进来吧。」',
      exampleDialogue: '',
      systemPrompt: '  只写短句。  ',
      alternateGreetings: ['「别回头。」', '   ', '「风从北面来。」'],
    }),
  );
  const record = materializer.state.characters['c1'];
  assert.equal(record?.systemPrompt, '只写短句。', '两端空白要去掉');
  assert.deepEqual(record?.alternateGreetings, ['「别回头。」', '「风从北面来。」'], '空行过滤');

  const bare = new Materializer();
  bare.apply(
    characterUpsert(base, {
      characterId: 'c2',
      name: '没有提示',
      description: '',
      personality: '',
      scenario: '',
      firstMessage: '',
      exampleDialogue: '',
    }),
  );
  const plain = bare.state.characters['c2'];
  assert.equal(plain?.systemPrompt, undefined, '没写就不落字段（而不是空串）');
  assert.equal(plain?.alternateGreetings, undefined);
});

test('角色：编辑时清空系统提示会真的清掉（否则再也回不到全局提示）', () => {
  const materializer = new Materializer();
  const clock2 = new HlcClock({ now: () => 2_000 });
  const later = { deviceId: 'device-a', clock: clock2 };
  materializer.apply(
    characterUpsert(base, { characterId: 'c1', name: 'x', description: '', personality: '', scenario: '', firstMessage: '', exampleDialogue: '', systemPrompt: '旧提示' }),
  );
  materializer.apply(
    characterUpsert(later, { characterId: 'c1', name: 'x', description: '', personality: '', scenario: '', firstMessage: '', exampleDialogue: '', systemPrompt: '' }),
  );
  assert.equal(materializer.state.characters['c1']?.systemPrompt, undefined);
});
