/**
 * @storyforge/plugin-api —— 插件作者唯一需要的依赖。
 *
 * 内核实现（Context/加载器/组合层）在 `@storyforge/kernel`，本包**不依赖任何内部包**，
 * 因此第三方插件可以在不阅读内核源码的情况下写出来。
 */
export type {
  ActivationOutcome,
  ConfigLike,
  ConfigResult,
  Disposer,
  Logger,
  PluginContext,
  PluginLike,
} from './contract.ts';
export {
  defineConfig,
  type ArrayNode,
  type BooleanNode,
  type LiteralNode,
  type NumberNode,
  type ObjectNode,
  type SchemaDictionary,
  type SchemaNode,
  type StringNode,
  type UnionNode,
} from './config.ts';
export { defineRegistry, Registry, type RegistryEntry } from './registry.ts';
