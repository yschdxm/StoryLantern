import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState } from '../src/app/state.ts';
import { SETTING_KEYS } from '../src/data/types.ts';
import { buildChatOptionsV2 } from '../src/screens/chat-request.ts';

/**
 * 状态 → 装配输入的映射：历史必须带消息 id（引用窗口要用），cite 只由设置决定。
 */

function stateOf(settings: Record<string, string> = {}): AppState {
  return {
    settings,
    sessions: [{ id: 's1', title: '雨夜' }],
    messages: [
      { id: 'm1', role: 'user', content: '你好', status: 'done' },
      { id: 'm2', role: 'assistant', content: '夜里好。', status: 'done' },
    ],
    memories: [],
  } as unknown as AppState;
}

test('历史项带 id，顺序保持', () => {
  const options = buildChatOptionsV2({ state: stateOf(), sessionId: 's1', workspace: undefined });
  assert.deepEqual(
    options.history.map((item) => [item.id, item.role, item.content]),
    [
      ['m1', 'user', '你好'],
      ['m2', 'assistant', '夜里好。'],
    ],
  );
});

test('cite：默认关闭；chat.cite=on 才开启；其他值都算关闭', () => {
  assert.equal(buildChatOptionsV2({ state: stateOf(), sessionId: 's1', workspace: undefined }).cite, false);
  assert.equal(
    buildChatOptionsV2({
      state: stateOf({ [SETTING_KEYS.cite]: 'on' }),
      sessionId: 's1',
      workspace: undefined,
    }).cite,
    true,
  );
  for (const value of ['off', 'ON', '1', 'true']) {
    assert.equal(
      buildChatOptionsV2({
        state: stateOf({ [SETTING_KEYS.cite]: value }),
        sessionId: 's1',
        workspace: undefined,
      }).cite,
      false,
      value,
    );
  }
});
