/**
 * @storylantern/wire —— 类型化 RPC。
 *
 * 宿主把 Service 方法 `expose()` 出去，客户端用 `service<T>()` 把它当本地对象调用；
 * 承载可以是进程内直连、Tauri IPC 或 HTTP/SSE，调用方代码不变。
 */
export {
  errorToShape,
  shapeToError,
  WireError,
  type WireErrorShape,
  type WireInvokeRequest,
  type WireManifest,
  type WireMethodDescriptor,
  type WireMethodKind,
  type WireServiceManifest,
  type WireTransport,
} from './transport.ts';
export { WireHost, type ExposeOptions, type WireHandler } from './host.ts';
export { createMemoryPair, WireClient, type CallOptions, type MemoryPair, type MemoryPairOptions, type WireClientOptions } from './client.ts';
export {
  createTauriBridgeFromGlobal,
  createTauriTransport,
  type TauriBridge,
  type TauriTransportOptions,
} from './tauri.ts';
export { createWireInspectProvider, type WireInspectProvider } from './inspect.ts';
