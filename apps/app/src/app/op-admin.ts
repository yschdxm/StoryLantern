/**
 * 开发者面板用的 op 日志入口：只有 op-log 仓储（宿主实现）才有统计/重建/快照能力。
 *
 * 从 `main.tsx` 抽出来有两个原因：主入口贴着 400 行门禁；这段能力探测本身是可单测的纯装配逻辑
 * （不依赖 React）。
 */

import type { OpLogRepository } from '../data/op-repository.ts';
import type { Repository } from '../data/repository.ts';
import type { OpLogAdmin } from '../screens/screen-props.ts';

/** 把 `Repository` 收窄成 `OpLogRepository` 的开发者接口；浏览器最小实现返回 undefined。 */
export function createOpAdmin(repository: Repository): OpLogAdmin | undefined {
  const opLogRepository = repository as Partial<OpLogRepository>;
  if (typeof opLogRepository.logStats !== 'function' || typeof opLogRepository.rebuild !== 'function') return undefined;
  return {
    stats: () => opLogRepository.logStats!(),
    rebuild: () => opLogRepository.rebuild!(),
    counts: () => opLogRepository.counts!(),
    ...(typeof opLogRepository.createSnapshot === 'function'
      ? { createSnapshot: () => opLogRepository.createSnapshot!() }
      : {}),
    ...(typeof opLogRepository.clearSnapshot === 'function' ? { clearSnapshot: () => opLogRepository.clearSnapshot!() } : {}),
  };
}
