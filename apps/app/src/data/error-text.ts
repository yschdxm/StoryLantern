/** 界面侧统一从这里取 `describeError`；实现住在 `packages/sync-core`（包不能依赖 app，反过来可以）。 */
export { describeError } from '../../../../packages/sync-core/src/error-text.ts';
