import { useEffect, useState } from 'react';
import { describeError } from '../data/error-text.ts';
import type { AssembleFn } from '../../../../plugins/writing-pipeline/src/index.ts';
import type { Router } from '../app/router.ts';
import type { AppState, AppStore } from '../app/state.ts';
import type { ChatClient } from '../data/chat-client.ts';
import type { HostClient } from '../host-panel.ts';
import type { WireTransport } from '../../../../packages/wire/src/index.ts';

/** 每个界面都能拿到的几样东西：状态/动作、路由、宿主诊断、聊天（模型）、op 日志（M1 之后的事实源）。 */
export interface ScreenProps {
  /** 宿主 wire 通道（部分界面用它做自检，例如「测试向量来源」）。 */
  transport?: WireTransport;
  store: AppStore;
  router: Router;
  host: HostClient;
  chat: ChatClient;
  /** 只有 op-log 仓储才有：日志统计与"从日志重建"。浏览器/内存实现没有。 */
  ops?: OpLogAdmin;
  /** 同步：只有 op-log 仓储 + 配置齐全时才有。 */
  sync?: SyncAdmin;
  /** 组装管线（来自组合出来的插件）。缺省时 prompt.ts 走兜底拼接，并在面板里说明。 */
  assemble?: AssembleFn;
}

export interface SyncAdmin {
  /** 环境是否支持（WebCrypto 需要安全上下文）。 */
  available: boolean;
  /** WebDAV 后端插件是否被组合进来（关掉 bundle 那行就没有）。 */
  backendAvailable: boolean;
  /** 本地文件夹同步是否可用（需要宿主提供文件读写）。 */
  folderAvailable: boolean;
  /** 已经存过同步口令（口令只写：界面不回显明文，也不回显掩码）。 */
  hasSecret: boolean;
  /** 配置是否有问题（缺地址/口令等）。 */
  problem(): Promise<string | undefined>;
  /** 当前本地文件夹根目录（宿主解析出来的绝对路径）。 */
  folderRoot(): Promise<string>;
  /**
   * 用系统的目录选择器（Android SAF）挑一个文件夹。
   *
   * 只做到"选中并记住"：同步的读写还没走 SAF，所以返回的结果用于显示与后续接管，
   * 界面必须写清这一点。没有宿主（浏览器）时返回 undefined。
   */
  safPick?: (() => Promise<{ uri: string; name: string } | { error: string }>) | undefined;
  /** 跑一次同步；`secret` 非空时先存进设备本地 kv。 */
  run(secret?: string): Promise<{ uploaded: number; downloaded: number; appliedOps: number; warnings: string[]; root?: string }>;
  /**
   * 设备名单（配对即登记；吊销是显式动作）。
   *
   * 为什么要它：GC 需要"所有活跃设备都已并入"这个判据，哑存储给不出，
   * 只能在客户端维护名单——没有名单就只能永不回收。
   */
  devices(): Promise<SyncDevice[]>;
  /** 吊销某台设备：它离线期间的新数据将不再被保留（界面必须先警告）。 */
  revoke(deviceId: string): Promise<boolean>;
  /** 永久禁用（黑名单）：拒绝它的签名；要连读也断还得换代。 */
  ban(deviceId: string): Promise<boolean>;
  /** 生成恢复密钥（公钥发布到共享目录；私钥只返回这一次，请离线保存）。 */
  createRecovery(): Promise<{ publicKey: string; privateKey: string }>;
  /** 忘记同步口令时：用离线保存的恢复私钥签一份证明去加入（仍在等待接纳时 ok = false）。 */
  joinWithRecovery(privateKey: string): Promise<{ ok: boolean; reason?: string }>;
  /**
   * 回收分析（默认只分析、不动手）。
   *
   * `dryRun` 为 false 才会真的把段移进 `trash/`——这是**不可恢复**的动作，
   * 所以由用户显式确认后才执行。
   */
  collect(dryRun: boolean): Promise<{ candidates: string[]; moved: string[]; reasons: string[] }>;
}

export interface SyncDevice {
  deviceId: string;
  /** 显示名（本机 = "本机"）。 */
  name: string;
  /** 是否就是本机。 */
  self: boolean;
  /** 是否已被吊销。 */
  revoked: boolean;
  /** 永久禁用（黑名单）：知道口令也不许再进来；配合换代才能连读也断掉。 */
  banned: boolean;
  /** 加入时间（毫秒）。 */
  addedAt: number;
  /** 本机签名公钥（十六进制）；空串 = 还没公布（老版本或弱模式）。 */
  publicKey: string;
}

export interface OpLogAdmin {
  stats(): Promise<{
    count: number;
    lastSeq: number;
    devices: number;
    bytes: number;
    corrupt: number;
    load?: { mode: 'snapshot' | 'replay'; ms: number; covered: number; tail: number; problem?: string };
  }>;
  rebuild(): Promise<{ ops: number; characters: number; sessions: number; messages: number }>;
  /**
   * 实体数量**从 op 日志派生**。
   *
   * 为什么要单独给：宿主自检里的 `characters/sessions/messages` 读的是 M1 之前的旧表，
   * 迁移之后那些数字就冻住了。开发者面板如果继续显示它们，会让人以为数据没写进去。
   */
  counts(): Promise<{ characters: number; sessions: number; messages: number }>;
  /** 生成冷启动快照（日志不动）；没有设备本地存储时不可用。 */
  createSnapshot?(): Promise<{ upToHlc: { t: number; c: number }; opCount: number; digest: string; lastSeq: number }>;
  clearSnapshot?(): Promise<void>;
}

/** 订阅 store：只在引用变化时重渲染（状态本身是不可变替换的）。 */
export function useAppState(store: AppStore): AppState {
  const [state, setState] = useState<AppState>(() => store.getState());
  useEffect(() => store.subscribe(setState), [store]);
  return state;
}

/** 首屏加载一次；`deps` 变化时重跑（例如切换会话）。 */
export function useAsync(effect: () => Promise<void> | void, deps: readonly unknown[]): { error?: string; loading: boolean } {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    void Promise.resolve(effect())
      .catch((cause: unknown) => {
        if (alive) setError(describeError(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...(error === undefined ? {} : { error }), loading };
}
