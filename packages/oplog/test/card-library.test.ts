import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { cardLibrary, cardUpsert, freezeSnapshot, isCardLibraryEnabled, type Op } from '../src/index.ts';
import { Materializer } from '../src/materialize.ts';
import type { CharacterCard } from '../../cards/src/index.ts';

/**
 * 卡片库级启停（`card.library`）：与卡片内容分开存、按独立 HLC 收敛。
 *
 * 为什么要单独测：重启/同步后"这张卡是退役还是草稿"必须稳定；
 * 而且"停用 op 先到、卡片后到"（乱序）不能把状态重置回启用。
 */

function base(deviceId: string, t = 1_700_000_000_000) {
  return { deviceId, clock: new HlcClock({ now: () => t }) };
}

function card(id: string, name: string): CharacterCard {
  return {
    card_type: 'character',
    meta: { id, schema: 'rolecard/v1', name, version: '1.0.0', language: 'zh-CN', rating: 'general', description: '' },
    identity: { name, background: '' },
    persona: { summary: '', traits: [], knowledge_boundary: '', ability_boundary: '' },
    speech: { style: '' },
  };
}

test('库级启停：没有记录时默认启用', () => {
  const m = new Materializer();
  m.apply(cardUpsert(base('A'), { card: card('c1', '星野') }));
  assert.equal(isCardLibraryEnabled(m.state, 'c1'), true);
});

test('库级启停：停用 / 重新启用都生效', () => {
  const m = new Materializer();
  m.apply(cardUpsert(base('A'), { card: card('c1', '星野') }));
  m.apply(cardLibrary(base('A', 1_700_000_001_000), { card_id: 'c1', enabled: false }));
  assert.equal(isCardLibraryEnabled(m.state, 'c1'), false);

  m.apply(cardLibrary(base('A', 1_700_000_002_000), { card_id: 'c1', enabled: true }));
  assert.equal(isCardLibraryEnabled(m.state, 'c1'), true);
});

test('库级启停：乱序到达按 HLC 收敛（旧的停用不会盖掉新的启用）', () => {
  const older = cardLibrary(base('A', 1_700_000_001_000), { card_id: 'c1', enabled: false });
  const newer = cardLibrary(base('B', 1_700_000_009_000), { card_id: 'c1', enabled: true });
  const forward = new Materializer();
  forward.applyAll([older, newer]);
  const backward = new Materializer();
  backward.applyAll([newer, older]);
  assert.equal(isCardLibraryEnabled(forward.state, 'c1'), true);
  assert.equal(isCardLibraryEnabled(backward.state, 'c1'), true);
  assert.equal(freezeSnapshot(forward.snapshot()), freezeSnapshot(backward.snapshot()));
});

test('库级启停：停用 op 先于卡片到达也不丢（独立记录）', () => {
  const m = new Materializer();
  const disable: Op = cardLibrary(base('A', 1_700_000_001_000), { card_id: 'c2', enabled: false });
  m.apply(disable);
  m.apply(cardUpsert(base('B', 1_700_000_000_000), { card: card('c2', '后来才到') }));
  assert.equal(isCardLibraryEnabled(m.state, 'c2'), false);
});
