import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createContext, type Context } from '../../../packages/kernel/src/context.ts';
import { activateComposition, composeProfile } from '../../../packages/kernel/src/loader.ts';
import { ActivationTracker } from '../../../packages/kernel/src/plugin.ts';
import { parseYaml } from '../../../packages/kernel/src/yaml.ts';
import type { LocaleService } from '../../../packages/plugin-api/src/index.ts';
import type { AssembleFn } from '../../../plugins/writing-pipeline/src/index.ts';
import { resolver } from '../src/resolver.ts';
import { buildViewModel, type ChatMessage } from '../src/view-model.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

const MESSAGES: ChatMessage[] = [
  { id: 'm1', author: 'user', text: '风从北面灌进走廊，把灯芯压得只剩一线。我把地图摊在桌上，指给你看那道被雪埋了半个冬天的隘口。' },
  { id: 'm2', author: 'character', text: '星野没有立刻回答。她先用指尖把地图上的折痕一点点抚平，像是在抚平一件旧事的褶皱。' },
  { id: 'm3', author: 'user', text: '我把怀里那枚铜铃放在桌上。铃身有一道细缝，是那年冬天留下的，我想知道她认不认得这个声音。' },
  { id: 'm4', author: 'character', text: '她终于笑了，笑意很浅，像雪线之上偶然露出的天光。她说认得，然后从袖中抽出一张更旧的地图。' },
  { id: 'm5', author: 'user', text: '我把灯芯挑高了些，让那条河在纸上显出来。河道的走向和隘口几乎是平行的，只是要穿过一片没有人愿意过夜的松林。' },
  { id: 'm6', author: 'character', text: '她说松林里有别的东西在听，能听见人心里最想留住的名字。她问我，愿不愿意用一半的路程换一个不会丢的名字。' },
];

interface Runtime {
  ctx: Context;
  locale: LocaleService;
  assemble: AssembleFn;
  tracker: ActivationTracker;
}

/** 与浏览器端同一套组合，只是 patch 从磁盘读（浏览器用 `?raw`）。 */
async function createRuntime(): Promise<Runtime> {
  const corePatch = parseYaml(await readFile(path.join(ROOT, 'bundles/core/storylantern.patch.yml'), 'utf8'));
  const userPatch = parseYaml(await readFile(path.join(ROOT, 'apps/app/src/user-patch.yml'), 'utf8'));

  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(
    ctx,
    composeProfile([
      { source: 'bundle:core', rows: corePatch },
      { source: 'user-patch', rows: userPatch },
    ]),
    resolver,
    { tracker },
  );
  await ctx.settle();
  return {
    ctx,
    tracker,
    locale: ctx.require<LocaleService>('locale'),
    assemble: ctx.require<AssembleFn>('context.assemble'),
  };
}

test('视图模型（中文）：标题、角色标签、块图与裁剪理由都可直接渲染', async () => {
  const runtime = await createRuntime();
  const vm = buildViewModel({
    locale: runtime.locale,
    assemble: runtime.assemble,
    messages: MESSAGES,
    characterName: '星野',
    locales: runtime.locale.locales(),
    plugins: runtime.tracker.list().map((outcome) => ({ id: outcome.id, status: outcome.status })),
  });

  assert.equal(vm.title, '叙灯');
  assert.match(vm.tagline, /本地优先/);
  assert.equal(vm.syncStatus, '已同步');
  assert.deepEqual(vm.localeOptions, ['en', 'zh-CN']);
  assert.equal(vm.chat.length, 6);
  assert.deepEqual([...new Set(vm.chat.map((row) => row.roleLabel))], ['用户', '角色']);

  // 用户 patch 把预算压到 256：历史块（4 条长消息）必然被裁掉，且带可读理由
  assert.equal(vm.budgetTokens, 256);
  const history = vm.graph.find((row) => row.id === 'history');
  assert.ok(history, '应当有 history 块');
  assert.equal(history?.included, false);
  assert.equal(history?.includedLabel, '已裁掉');
  assert.match(history?.reason ?? '', /预算不足裁掉/);
  assert.ok(vm.graph.some((row) => row.included), '也应至少有一个被纳入的块');
  assert.match(vm.budgetSummary, /已用 \d+ \/ 256 tokens/);
  assert.equal(vm.graphTitle, '上下文块图');
  await runtime.ctx.dispose();
});

test('切到英文：整份文案（标题/角色/块图/摘要/插件数）一起变英文', async () => {
  const runtime = await createRuntime();
  runtime.locale.setLocale('en');
  const vm = buildViewModel({
    locale: runtime.locale,
    assemble: runtime.assemble,
    messages: MESSAGES,
    characterName: 'Hoshino',
    locales: runtime.locale.locales(),
    plugins: runtime.tracker.list().map((outcome) => ({ id: outcome.id, status: outcome.status })),
  });

  assert.equal(vm.locale, 'en');
  assert.equal(vm.title, 'Story Lantern');
  assert.equal(vm.syncStatus, 'Up to date');
  assert.deepEqual([...new Set(vm.chat.map((row) => row.roleLabel))], ['User', 'Character']);
  assert.equal(vm.graphTitle, 'Context graph');
  assert.equal(vm.graph.find((row) => row.id === 'history')?.includedLabel, 'Dropped');
  assert.match(vm.graph.find((row) => row.id === 'history')?.reason ?? '', /Dropped for budget/);
  assert.match(vm.budgetSummary, /tokens used/);
  await runtime.ctx.dispose();
});

test('插件行来自组合本身：powering 界面的正是 patch 里的那 7 行', async () => {
  const runtime = await createRuntime();
  const vm = buildViewModel({
    locale: runtime.locale,
    assemble: runtime.assemble,
    messages: MESSAGES,
    characterName: '星野',
    locales: runtime.locale.locales(),
    plugins: runtime.tracker.list().map((outcome) => ({ id: outcome.id, status: outcome.status })),
  });

  assert.deepEqual(
    vm.plugins.map((plugin) => `${plugin.id}:${plugin.status}`),
    ['locale:active', 'log-sink:active', 'settings:active', 'blocks:active', 'pipeline:active', 'sync-memory:active', 'sync-folder:disabled'],
  );
  assert.equal(vm.pluginsSummary, '已激活 7 个插件');
  await runtime.ctx.dispose();
});

test('预算足够大时不再有被裁掉的块（同一份数据、只改预算）', async () => {
  const runtime = await createRuntime();
  const vm = buildViewModel({
    locale: runtime.locale,
    assemble: runtime.assemble,
    messages: MESSAGES,
    characterName: '星野',
    locales: runtime.locale.locales(),
    plugins: [],
    budgetTokens: 20_000,
  });

  assert.equal(vm.omitted, 0);
  assert.equal(vm.graph.every((row) => row.included), true);
  assert.match(vm.budgetSummary, /裁掉 0 块/);
  await runtime.ctx.dispose();
});
