/**
 * 传输层契约。
 *
 * 客户端的形状刻意只有一个方法 `invoke`：普通调用产出恰好一个值，流式调用产出多个值。
 * 这样同一套代码可以跑在三种承载上：
 *  - 进程内直连（M0：界面与宿主同进程，零序列化）
 *  - Tauri 的 invoke/IPC（桌面/移动）
 *  - HTTP + SSE（将来的 relay 或 Web 版）
 */

export type WireMethodKind = 'call' | 'stream';

export interface WireMethodDescriptor {
  name: string;
  kind: WireMethodKind;
  description?: string;
}

export interface WireServiceManifest {
  name: string;
  description?: string;
  methods: WireMethodDescriptor[];
}

export interface WireManifest {
  services: WireServiceManifest[];
}

export interface WireInvokeRequest {
  service: string;
  method: string;
  args: unknown[];
  signal?: AbortSignal;
}

export interface WireTransport {
  /** 传输自身的名字，仅用于诊断。 */
  readonly kind: string;
  /** 有的承载能直接给出清单（进程内、IPC），有的要额外请求（HTTP）。 */
  manifest?(): Promise<WireManifest | undefined>;
  invoke(request: WireInvokeRequest): AsyncIterable<unknown>;
}

export interface WireErrorShape {
  code: string;
  message: string;
}

/** 跨承载传递的错误：保留 code 供上层分支，而不是让调用方去匹配文案。 */
export class WireError extends Error {
  readonly code: string;
  readonly service: string;
  readonly method: string;

  constructor(code: string, message: string, context: { service?: string; method?: string } = {}) {
    super(message);
    this.name = 'WireError';
    this.code = code;
    this.service = context.service ?? '(unknown)';
    this.method = context.method ?? '(unknown)';
  }

  toShape(): WireErrorShape {
    return { code: this.code, message: this.message };
  }
}

export function errorToShape(error: unknown): WireErrorShape {
  if (error instanceof WireError) return error.toShape();
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return { code: typeof code === 'string' ? code : 'internal', message: error.message };
  }
  return { code: 'internal', message: String(error) };
}

export function shapeToError(shape: WireErrorShape, context: { service?: string; method?: string } = {}): WireError {
  return new WireError(shape.code, shape.message, context);
}
