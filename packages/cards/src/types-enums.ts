/** 跨文件共用的小枚举（用 `as const` 数组 + 联合类型：门禁禁止 TS `enum`）。 */

export type Tone = 'light' | 'serious' | 'dark' | 'mystery';

export const TONES: readonly Tone[] = ['light', 'serious', 'dark', 'mystery'];

/** 三种开场模式：智能 / 指定 / 用户。 */
export type OpeningMode = 'auto' | 'designated' | 'self';

export const OPENING_MODES: readonly OpeningMode[] = ['auto', 'designated', 'self'];
