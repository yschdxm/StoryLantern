import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createAppRuntime, type AppRuntime } from './composition.ts';
import { createHostClient } from './host-panel.ts';
import { buildViewModel, type ChatMessage } from './view-model.ts';
import './styles.css';

/**
 * 宿主客户端在模块加载时确定一次：在 Tauri 里探测到 `window.__TAURI__` 就走 IPC，
 * 在浏览器里则是"不可用"的降级实现（面板会说明这一点，而不是假装有宿主）。
 */
const host = createHostClient();

/**
 * 演示数据：刻意写成长句，好让默认预算（用户 patch 里调成 256）真的裁掉历史块，
 * 从而在界面上直接看到"被裁掉 + 理由"。
 */
const DEMO_MESSAGES: ChatMessage[] = [
  { id: 'm1', author: 'user', text: '风从北面灌进走廊，把灯芯压得只剩一线。我把地图摊在桌上，指给你看那道被雪埋了半个冬天的隘口，说我们必须在第三次钟响之前翻过去。' },
  { id: 'm2', author: 'character', text: '星野没有立刻回答。她先用指尖把地图上的折痕一点点抚平，像是在抚平一件旧事的褶皱，然后才抬起眼，说那条路她走过一次，代价是丢了一个名字。' },
  { id: 'm3', author: 'user', text: '我把怀里那枚铜铃放在桌上。铃身有一道细缝，是那年冬天留下的。我问她，认不认得这个声音——如果认得，那我们就还有别的走法。' },
  { id: 'm4', author: 'character', text: '她终于笑了，笑意很浅，像雪线之上偶然露出的天光。她说认得，然后从袖中抽出一张更旧的地图，上面用褪色的墨标着一条没有名字的河。' },
  { id: 'm5', author: 'user', text: '我把灯芯挑高了些，让那条河在纸上显出来。河道的走向和隘口几乎是平行的，只是要穿过一片没有人愿意过夜的松林。' },
  { id: 'm6', author: 'character', text: '她说松林里有别的东西在听，能听见人心里最想留住的名字。她问我，愿不愿意用一半的路程换一个不会丢的名字。' },
];

function Root() {
  const [runtime, setRuntime] = useState<AppRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    createAppRuntime()
      .then(setRuntime)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  if (error !== null) return <pre className="error">{error}</pre>;
  if (runtime === null) return <p className="loading">正在组合插件…</p>;

  const viewModel = buildViewModel({
    locale: runtime.locale,
    assemble: runtime.assemble,
    messages: DEMO_MESSAGES,
    characterName: '星野',
    locales: runtime.locale.locales(),
    plugins: runtime.tracker.list().map((outcome) => ({ id: outcome.id, status: outcome.status })),
  });

  return (
    <App
      key={revision}
      viewModel={viewModel}
      host={host}
      onChangeLocale={(next) => {
        runtime.locale.setLocale(next);
        setRevision((value) => value + 1);
      }}
    />
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('缺少 #root 容器');
createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
