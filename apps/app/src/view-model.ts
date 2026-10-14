import type { LocaleService } from '../../../packages/plugin-api/src/index.ts';
import type { AssembleFn, PromptGraph } from '../../../plugins/writing-pipeline/src/index.ts';

/**
 * 视图模型：把"服务 + 数据"整理成界面可以直接渲染的结构。
 *
 * 为什么单独一层：真实逻辑（块图装配、文案本地化、裁剪理由）都在这里，
 * 因此它可以用 Node 直接测试，不需要浏览器、也不需要 JSX 转换。
 * 组件只负责把这份模型画出来。
 */

export interface ChatMessage {
  id: string;
  author: 'user' | 'character';
  text: string;
}

export interface ChatRow {
  id: string;
  author: string;
  text: string;
  /** 已经本地化过的角色标签（用户/角色）。 */
  roleLabel: string;
}

export interface GraphRow {
  id: string;
  included: boolean;
  includedLabel: string;
  tokens: number;
  reason: string;
}

export interface PluginRow {
  id: string;
  status: string;
}

export interface AppViewModel {
  locale: string;
  localeOptions: string[];
  title: string;
  tagline: string;
  syncStatus: string;
  pluginsSummary: string;
  plugins: PluginRow[];
  chat: ChatRow[];
  graph: GraphRow[];
  graphTitle: string;
  budgetSummary: string;
  usedTokens: number;
  budgetTokens: number;
  omitted: number;
}

export interface BuildViewModelInput {
  locale: LocaleService;
  assemble: AssembleFn;
  messages: readonly ChatMessage[];
  characterName: string;
  locales: readonly string[];
  plugins: readonly PluginRow[];
  budgetTokens?: number;
}

const AUTHOR_KEYS = { user: 'chat.author.user', character: 'chat.author.character' } as const;

export function buildViewModel(input: BuildViewModelInput): AppViewModel {
  const { locale, assemble } = input;
  const graph: PromptGraph = assemble(
    {
      sessionTitle: 'demo',
      characterName: input.characterName,
      userName: '旅人',
      transcript: input.messages.map((message) => `${message.author === 'user' ? '旅人' : input.characterName}：${message.text}`),
    },
    input.budgetTokens,
  );

  return {
    locale: locale.locale,
    localeOptions: [...input.locales],
    title: locale.t('app.name'),
    tagline: locale.t('app.tagline'),
    syncStatus: locale.t('sync.status.idle'),
    pluginsSummary: locale.t('app.pluginsActive', { count: input.plugins.length }),
    plugins: input.plugins.map((plugin) => ({ ...plugin })),
    chat: input.messages.map((message) => ({
      id: message.id,
      author: message.author,
      text: message.text,
      roleLabel: locale.t(AUTHOR_KEYS[message.author]),
    })),
    graph: graph.nodes.map((node) => ({
      id: node.id,
      included: node.included,
      includedLabel: node.included ? locale.t('graph.included') : locale.t('graph.omitted'),
      tokens: node.tokens,
      reason: node.reason,
    })),
    graphTitle: locale.t('graph.title'),
    budgetSummary: locale.t('graph.budget', {
      used: graph.usedTokens,
      budget: graph.budgetTokens,
      omitted: graph.omitted,
    }),
    usedTokens: graph.usedTokens,
    budgetTokens: graph.budgetTokens,
    omitted: graph.omitted,
  };
}
