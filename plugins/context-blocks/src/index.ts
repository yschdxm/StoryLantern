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

/**
 * 实体级来源（B21）：这个块的内容**来自哪里**，供请求面板说明"模型看到的这段是谁的"。
 *
 * 聚合块（多个角色/多条命中）把 id 用逗号连接；单实体块就是那一个 id。
 * 类型里 `setting` 留给设置类来源，避免以后加来源时再改一次契约。
 */
export type BlockSourceType = 'character' | 'scene' | 'item' | 'lore' | 'session' | 'setting' | 'summary' | 'memory';

export interface BlockSource {
  type: BlockSourceType;
  /** 实体 id；聚合时为逗号分隔（按稳定顺序）。 */
  id?: string;
  /** 展示名（面板直接用；聚合时为顿号分隔）。 */
  label?: string;
}

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
   * 应用侧的块用一个带类型的读取器收口（见 `apps/app/src/data/prompt-blocks-v2.ts`）。
   */
  data?: Record<string, unknown>;
}

export interface BlockDefinition {
  id: string;
  placement: BlockPlacement;
  /** 越大越先满足预算。 */
  priority: number;
  /**
   * 本块自己的 token 预算（B20）：超出时**块内截断**（末尾 `…`），而不是整块被全局预算丢掉。
   * 缺省 = 本块没有独立预算（仍受全局预算约束）。
   */
  tokenBudget?: number;
  /** 必须保留（B20）：全局预算不足时不裁它；没有它这次请求就不可用（例如角色设定/本局处境）。 */
  mustKeep?: boolean;
  /** 实体级来源（B21）：静态对象或按装配上下文计算的函数。 */
  source?: BlockSource | ((context: BlockContext) => BlockSource | undefined);
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
