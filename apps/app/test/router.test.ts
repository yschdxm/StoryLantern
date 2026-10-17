import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeToHash, TABS, activeTabName, parentOf } from '../src/app/router.ts';

/**
 * hash 路由的往返必须无损：实体 id **不保证是 ASCII**。
 *
 * 真机踩过的坑：从事实导出的典籍 id 是 `fact-fact-铜铃-…`，`location.hash` 会返回
 * 百分号编码后的形式；不解码就会拿 `%E9%93%9C…` 去查卡片，编辑器显示"找不到这张卡片"。
 */

test('路由：中文/空格/保留字符的 id 往返无损', () => {
  const ids = [
    '01M4ZT6M6F11S2ZZGVJ2GJ35PT',
    'fact-fact-铜铃-父亲-留下来的遗物-01M4Z',
    'a b/c?d#e&f',
    '100%',
  ];
  for (const cardId of ids) {
    for (const kind of ['scene', 'item', 'lore'] as const) {
      const route = { name: 'worldCard', kind, cardId } as const;
      const parsed = parseRoute(routeToHash(route));
      assert.deepEqual(parsed, route, `卡片 id 往返失败：${cardId}`);
    }
  }
  const chat = { name: 'chat', sessionId: '会话-1 号' } as const;
  assert.deepEqual(parseRoute(routeToHash(chat)), chat);
  const character = { name: 'character', characterId: '角色 A' } as const;
  assert.deepEqual(parseRoute(routeToHash(character)), character);
});

test('路由：畸形的百分号编码不崩（回退原文）', () => {
  const parsed = parseRoute('#/worldcard/lore/%E4%ZZ');
  assert.equal(parsed.name, 'worldCard');
});

test('路由：世界标签是根页面，卡片编辑器回到世界（带类型）', () => {
  const world = TABS.map((tab) => tab.route).find((route) => route.name === 'world');
  assert.ok(world !== undefined, '底部第三个标签应指向 world');
  assert.deepEqual(parentOf({ name: 'worldCard', kind: 'item', cardId: 'x' }), { name: 'world', kind: 'item' });
  assert.equal(activeTabName({ name: 'worldCard', kind: 'lore', cardId: 'x' }), 'world');
});
