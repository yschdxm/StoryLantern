/**
 * 混合逻辑时钟（HLC）。
 *
 * 为什么不用纯墙上时钟：设备时钟会漂移、会被用户改，纯时间戳排序会把因果关系排反。
 * 为什么不用纯 Lamport 计数：那样排序完全脱离真实时间，无法判断"谁更新"。
 * HLC 取两者之长：`t` 贴近墙上时钟（对漂移限幅），`c` 在 `t` 相同时保证因果序。
 */

export interface Hlc {
  /** 毫秒时间戳（受已观察到的远端值抬高，因此不会被调慢的本地时钟拉回）。 */
  t: number;
  /** 同一毫秒内的因果计数器。 */
  c: number;
}

export interface HlcClockOptions {
  now?: () => number;
  /** 允许本地时钟领先远端多少毫秒（超出则拒绝推进，防止被恶意/错误时钟带飞）。 */
  maxDriftMs?: number;
}

export class HlcClock {
  #t = 0;
  #c = 0;
  readonly #now: () => number;
  readonly #maxDriftMs: number;

  constructor(options: HlcClockOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxDriftMs = options.maxDriftMs ?? 24 * 60 * 60 * 1000;
  }

  get current(): Hlc {
    return { t: this.#t, c: this.#c };
  }

  /** 本地事件：推进并返回本次事件的时间戳。 */
  tick(): Hlc {
    const wall = this.#now();
    if (wall > this.#t) {
      this.#t = wall;
      this.#c = 0;
    } else {
      this.#c += 1;
    }
    return { t: this.#t, c: this.#c };
  }

  /** 观察到远端事件（收到 op 时调用），保证后续本地事件的排序在远端之后。 */
  merge(remote: Hlc, source?: string): Hlc {
    const wall = this.#now();
    const maxT = Math.max(wall, this.#t, remote.t);
    if (maxT - wall > this.#maxDriftMs && source !== undefined) {
      throw new Error(`远端口 '${source}' 的时钟比本地快 ${maxT - wall} ms，超过允许漂移上限`);
    }

    if (maxT === this.#t && maxT === remote.t) this.#c = Math.max(this.#c, remote.c) + 1;
    else if (maxT === this.#t) this.#c += 1;
    else if (maxT === remote.t) this.#c = remote.c + 1;
    else this.#c = 0;

    this.#t = maxT;
    return { t: this.#t, c: this.#c };
  }
}

/** 全序比较：先比 t，再比 c；完全相等时由调用方用 opId 破平局。 */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.t !== b.t) return a.t < b.t ? -1 : 1;
  if (a.c !== b.c) return a.c < b.c ? -1 : 1;
  return 0;
}

/**
 * Op 的全序比较键：`t:c:opId`。
 * 所有设备用它得到同一顺序，因此重放结果必然一致（收敛性依赖于此）。
 */
export function hlcSortKey(hlc: Hlc, tiebreaker: string): string {
  return `${hlc.t.toString().padStart(16, '0')}:${hlc.c.toString().padStart(8, '0')}:${tiebreaker}`;
}

export function compareOpOrder(
  a: { hlc: Hlc; opId: string },
  b: { hlc: Hlc; opId: string },
): number {
  const byHlc = compareHlc(a.hlc, b.hlc);
  if (byHlc !== 0) return byHlc;
  return a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0;
}
