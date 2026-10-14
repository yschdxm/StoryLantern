import { defineConfig, Registry } from '../../../packages/plugin-api/src/index.ts';
import type { PluginContext } from '../../../packages/plugin-api/src/index.ts';

export const name = 'context-blocks';

export const Config = defineConfig({
  maxBlocks: {
    type: 'number',
    default: 64,
    min: 1,
    max: 512,
    integer: true,
    description: '单个会话允许注册的块上限',
  },
});

export type BlockPlacement = 'system' | 'before-history' | 'at-depth' | 'after-history';

export interface BlockContext {
  sessionTitle: string;
  characterName?: string;
  userName?: string;
  transcript: string[];
  /**
   * 附加数据：块实现自己解释自己的那部分。
   *
   * 为什么留一个宽松的口子：块注册表是通用机制（内置块与第三方块没有地位差异），
   * 而"角色卡字段、世界书命中、自定义提示"这些是**应用域**的概念，不该塞进内核或这个插件的类型里。
   * 应用侧的块用一个带类型的读取器收口（见 `apps/app/src/data/prompt-blocks.ts`）。
   */
  data?: Record<string, unknown>;
}

export interface BlockDefinition {
  id: string;
  placement: BlockPlacement;
  /** 越大越先满足预算。 */
  priority: number;
  /** 返回 undefined 表示本块这次不参与（例如没有对应内容）。 */
  render(context: BlockContext): string | undefined;
}

export type BlockRegistry = Registry<BlockDefinition>;

/** 上下文块注册表。内置块也只是块，因此第三方块与内置块没有任何地位差异。 */
export function apply(ctx: PluginContext, config: Record<string, unknown>): void {
  const maxBlocks = typeof config.maxBlocks === 'number' ? config.maxBlocks : 64;
  const blocks: BlockRegistry = new Registry<BlockDefinition>({ onDuplicate: 'replace' });

  // 内置块之一：角色定义。它由本插件注册，而不是写死在管线里。
  blocks.register('character', {
    id: 'character',
    placement: 'system',
    priority: 100,
    render: (context) => (context.characterName ? `你是「${context.characterName}」。` : undefined),
  });

  ctx.set('context.blocks', blocks);
  ctx.effect(() => () => {
    blocks.clear();
    void maxBlocks;
  });
}
