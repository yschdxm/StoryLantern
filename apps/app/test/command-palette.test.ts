import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterCommands, nextIndex, type PaletteCommand } from '../src/ui/command-palette.ts';

const COMMANDS: PaletteCommand[] = [
  { id: 'sessions', label: '会话', hint: '导航', route: { name: 'sessions' } },
  { id: 'characters', label: '角色', hint: '导航', route: { name: 'characters' } },
  { id: 'settings', label: '设置', hint: '导航', route: { name: 'settings' } },
  { id: 'import', label: '导入', hint: '数据', route: { name: 'import' } },
];

test('命令面板过滤：空查询返回全部且顺序不变', () => {
  assert.deepEqual(
    filterCommands('', COMMANDS).map((command) => command.id),
    ['sessions', 'characters', 'settings', 'import'],
  );
  assert.deepEqual(
    filterCommands('   ', COMMANDS).map((command) => command.id),
    ['sessions', 'characters', 'settings', 'import'],
  );
});

test('命令面板过滤：匹配 label / id / hint，大小写不敏感', () => {
  assert.deepEqual(filterCommands('设置', COMMANDS).map((command) => command.id), ['settings']);
  assert.deepEqual(filterCommands('SET', COMMANDS).map((command) => command.id), ['settings']);
  // hint 也参与匹配：两个"导航"项都能被筛出来
  assert.deepEqual(filterCommands('导航', COMMANDS).map((command) => command.id), ['sessions', 'characters', 'settings']);
  assert.deepEqual(filterCommands('不存在的页面', COMMANDS), []);
});

test('键盘选择循环：↓ 到底回到第一个、↑ 到顶绕到最后一个', () => {
  assert.equal(nextIndex(0, 1, 4), 1);
  assert.equal(nextIndex(3, 1, 4), 0);
  assert.equal(nextIndex(0, -1, 4), 3);
  assert.equal(nextIndex(2, 2, 2), 0);
  // 空列表不应崩（返回 0）
  assert.equal(nextIndex(0, 1, 0), 0);
});
