import { useEffect, useState } from 'react';
import type { Router } from '../app/router.ts';
import type { AppState, AppStore } from '../app/state.ts';
import type { ChatClient } from '../data/chat-client.ts';
import type { HostClient } from '../host-panel.ts';

/** 每个界面都能拿到的四样东西：状态/动作、路由、宿主诊断、聊天（模型）。 */
export interface ScreenProps {
  store: AppStore;
  router: Router;
  host: HostClient;
  chat: ChatClient;
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
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
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
