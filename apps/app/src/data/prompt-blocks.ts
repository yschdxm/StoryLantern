import { scanLore, type ScanBook, type ScoredEntry } from '../../../../packages/lore/src/index.ts';
import type { BlockContext, BlockDefinition, BlockRegistry } from '../../../../plugins/context-blocks/src/index.ts';
import type { MessageRole } from './types.ts';

/**
 * 应用侧的上下文块：**唯一决定"模型看到什么"的代码**都在这里和 `prompt.ts`。
 *
 * 为什么用块注册表而不是在 `prompt.ts` 里拼字符串：
 *  - 每块有自己的优先级与预算参与顺序，超预算时能说清"谁被裁了、为什么"；
 *  - 关掉 bundle 里 `pipeline` 那一行，预算与理由就没了（功能真的消失，而不是静默降级）；
 *  - 第三方块与内置块走同一套机制，将来加"长期记忆""人物关系"这类块不必改内核。
 *
 * 历史消息**不进块**：块产出的是文本，而对话需要保留 role 结构（见 `prompt.ts` 的说明）。
 */

export interface PromptBlockCharacter {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  exampleDialogue: string;
}

export interface PromptBlockData {
  /** 设置里的自定义系统提示。 */
  custom: string;
  character?: PromptBlockCharacter;
  lorebooks: readonly ScanBook[];
  /** 历史消息（扫描世界书用；已按角色映射过）。 */
  history: ReadonlyArray<{ role: MessageRole; content: string }>;
  /** 世界书扫描结果：块渲染时写入，供可解释性面板读取。 */
  matchedLore?: ScoredEntry[];
}

/** 块渲染时读取的类型化视图（唯一的 `as` 收口）。 */
function dataOf(context: BlockContext): Partial<PromptBlockData> {
  return (context.data ?? {}) as Partial<PromptBlockData>;
}

export function characterBlockText(character: PromptBlockCharacter | undefined): string | undefined {
  if (character === undefined || character.name.trim() === '') return undefined;
  const parts = [`你要扮演「${character.name}」。`];
  if (character.description.trim() !== '') parts.push(`【设定】${character.description.trim()}`);
  if (character.personality.trim() !== '') parts.push(`【性格】${character.personality.trim()}`);
  if (character.scenario.trim() !== '') parts.push(`【场景】${character.scenario.trim()}`);
  if (character.exampleDialogue.trim() !== '') parts.push(`【对话示例】\n${character.exampleDialogue.trim()}`);
  parts.push('直接以角色身份说话，不要解释你是 AI，也不要用旁白复述设定。');
  return parts.join('\n');
}

/** 世界书块：命中就把条目正文拼成【相关设定】，并把命中详情写回 `data.matchedLore`。 */
export function loreBlockText(context: BlockContext): string | undefined {
  const data = dataOf(context);
  if (data.lorebooks === undefined || data.lorebooks.length === 0) return undefined;
  const result = scanLore({
    books: data.lorebooks,
    messages: (data.history ?? []).map((item) => ({ role: item.role, content: item.content })),
  });
  data.matchedLore = result.matched;
  if (result.matched.length === 0) return undefined;
  return `【相关设定】\n${result.matched.map((entry) => entry.content.trim()).join('\n')}`;
}

/** 注册应用侧的块。返回反注册函数（交给内核的 effect 生命周期）。 */
export function registerPromptBlocks(blocks: BlockRegistry): () => void {
  const definitions: BlockDefinition[] = [
    {
      id: 'app.system.custom',
      placement: 'system',
      // 用户自己写的排在最前，且优先保预算
      priority: 100,
      render: (context) => {
        const custom = dataOf(context).custom?.trim() ?? '';
        return custom === '' ? undefined : custom;
      },
    },
    {
      id: 'app.character.card',
      placement: 'system',
      priority: 90,
      render: (context) => characterBlockText(dataOf(context).character),
    },
    {
      id: 'app.lore.matched',
      placement: 'before-history',
      priority: 80,
      render: (context) => loreBlockText(context),
    },
  ];

  const offs = definitions.map((definition) => blocks.register(definition.id, definition));
  return () => {
    for (const off of offs.reverse()) off();
  };
}
