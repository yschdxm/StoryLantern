import { createContext, type Context } from '../../../packages/kernel/src/context.ts';
import { activateComposition, composeProfile } from '../../../packages/kernel/src/loader.ts';
import { parseYaml } from '../../../packages/kernel/src/yaml.ts';
import { ActivationTracker } from '../../../packages/kernel/src/plugin.ts';
import type { LocaleService } from '../../../packages/plugin-api/src/index.ts';
import type { AssembleFn } from '../../../plugins/writing-pipeline/src/index.ts';
import { resolver } from './resolver.ts';

// patch 当数据引入：界面加载的功能集合与 core bundle 完全一致，
// 想开/关一个功能只需改 patch（或叠加用户 patch），不用碰前端代码。
import corePatch from '../../../bundles/core/storylantern.patch.yml?raw';
import userPatch from './user-patch.yml?raw';

export interface AppRuntime {
  ctx: Context;
  tracker: ActivationTracker;
  locale: LocaleService;
  assemble: AssembleFn;
  warnings: readonly string[];
  dispose(): Promise<void>;
}

/** 按"bundle patch → 用户 patch"的顺序组合并激活，返回界面需要的能力。 */
export async function createAppRuntime(): Promise<AppRuntime> {
  const composition = composeProfile([
    { source: 'bundle:core', rows: parseYaml(corePatch) },
    { source: 'user-patch', rows: parseYaml(userPatch) },
  ]);

  const ctx = createContext();
  const tracker = new ActivationTracker();
  await activateComposition(ctx, composition, resolver, { tracker });
  await ctx.settle();

  const failed = tracker.list().filter((outcome) => outcome.status === 'failed');
  if (failed.length > 0) {
    throw new Error(`插件激活失败：${failed.map((item) => `${item.id}(${item.reason ?? ''})`).join('、')}`);
  }

  return {
    ctx,
    tracker,
    locale: ctx.require<LocaleService>('locale'),
    assemble: ctx.require<AssembleFn>('context.assemble'),
    warnings: composition.warnings,
    dispose: () => ctx.dispose(),
  };
}
