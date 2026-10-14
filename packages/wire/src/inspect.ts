import type { WireHost } from './host.ts';

/**
 * 把 wire 的清单暴露成 Inspect provider（结构上与内核的 `InspectProvider` 一致，
 * 因此不需要让 wire 依赖 kernel）。
 *
 * 价值：人和 AI 在写调用代码之前，可以先查"宿主到底暴露了什么、哪个方法是流式"——
 * 与内核的 Service/Event/Config 查询是同一套思路。
 */
export interface WireInspectProvider {
  platform: 'host';
  id: string;
  description: string;
  methods: Record<string, { description: string; run(input?: unknown): unknown }>;
}

export function createWireInspectProvider(host: WireHost): WireInspectProvider {
  return {
    platform: 'host',
    id: 'Wire',
    description: '宿主通过类型化 RPC 暴露给客户端的方法清单（含流式标记）。',
    methods: {
      manifest: {
        description: '全部 Service 与方法（含 kind: call|stream 与说明）。',
        run: () => host.manifest(),
      },
      listMethods: {
        description: '按 Service 过滤的方法名与类型。',
        run: (input) => {
          const service = typeof input === 'object' && input !== null ? (input as { service?: string }).service : undefined;
          const manifest = host.manifest();
          const services = service === undefined ? manifest.services : manifest.services.filter((item) => item.name === service);
          return {
            services: services.map((item) => ({
              name: item.name,
              methods: item.methods.map((method) => `${method.name} (${method.kind})`),
            })),
          };
        },
      },
    },
  };
}
