/**
 * @storyforge/kernel —— 插件内核。
 *
 * 内核之外没有非插件代码：一切能力都以 Service / Registry / Slot 的形式注册，
 * 注册即 effect，卸载即撤销。插件可以看到的 API 只有本包导出的内容。
 */
export { Context, createContext, type ContextOptions } from './context.ts';
export { EventBus } from './events.ts';
export { Registry, defineRegistry, type RegistryEntry } from '../../plugin-api/src/registry.ts';
export {
  defineConfig,
  type SchemaDictionary,
  type SchemaNode,
  type ArrayNode,
  type BooleanNode,
  type LiteralNode,
  type NumberNode,
  type ObjectNode,
  type StringNode,
  type UnionNode,
} from '../../plugin-api/src/config.ts';
export {
  activatePlugin,
  ActivationTracker,
  normalizePlugin,
  type ActivateOptions,
  type NormalizedPlugin,
} from './plugin.ts';
export {
  Composition,
  composeProfile,
  activateComposition,
  type ActivateCompositionOptions,
  type CompositionHost,
  type CompositionLayer,
  type PatchOptions,
  type ResolvedEntry,
} from './loader.ts';
export { parseYaml, resolveJsExpressions, YamlError, isJsExpression, type YamlJsExpression } from './yaml.ts';
export {
  bundlePatchOf,
  profileBundlesOf,
  type BundleManifest,
  type ProfilePackageJson,
} from './bundle.ts';
export {
  InspectRegistry,
  createKernelInspectProvider,
  type InspectMethod,
  type InspectProvider,
  type InspectQueryResult,
} from './inspect.ts';
export {
  createLogger,
  silentLogger,
  type ActivationOutcome,
  type ConfigLike,
  type ConfigResult,
  type Disposer,
  type Logger,
  type PluginLike,
} from './types.ts';
