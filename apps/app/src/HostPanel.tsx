import { useEffect, useState } from 'react';
import type { HostClient, HostViewModel, StreamChunk } from './host-panel.ts';

export interface HostPanelProps {
  client: HostClient;
}

/**
 * 开发者面板：宿主诊断 + 流式自检。
 *
 * 它**不再出现在主界面**（v0.1 里收进「设置 → 开发者」）。主界面是给人用的，
 * 诊断信息只该在需要排障时出现。
 */
export function HostPanel({ client }: HostPanelProps) {
  const [view, setView] = useState<HostViewModel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [streamed, setStreamed] = useState<{ text: string; chunks: number; cancelled: boolean } | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);

  const runStreamDemo = async (signal: AbortSignal): Promise<void> => {
    setStreamed({ text: '', chunks: 0, cancelled: false });
    const result = await client.streamDemo(
      'Story Lantern 的流式通道',
      (chunk: StreamChunk) => {
        if (chunk.text === '') return;
        setStreamed((current) => ({
          text: (current?.text ?? '') + chunk.text,
          chunks: (current?.chunks ?? 0) + 1,
          cancelled: false,
        }));
      },
      { signal },
    );
    setStreamed({ text: result.text, chunks: result.chunks, cancelled: result.cancelled });
    setView(await client.load());
  };

  useEffect(() => {
    void (async () => {
      const loaded = await client.load();
      setView(loaded);
      if (!client.available) return;
      try {
        await runStreamDemo(new AbortController().signal);
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = (): void => {
    const next = new AbortController();
    setController(next);
    void runStreamDemo(next.signal)
      .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setController(null));
  };

  return (
    <section className="settings-group" aria-label="开发者">
      <p className="muted">
        传输：{view === null ? '…' : view.available ? view.transport : '浏览器（无宿主 IPC）'}
        {view?.info !== undefined && ` · ${view.info.product} ${view.info.version} · ${view.info.os}/${view.info.arch}`}
        {view?.info !== undefined && ` · 宿主方法 ${view.methods.length} 个`}
      </p>
      {view?.error !== undefined && <p className="notice notice--warn">{view.error}</p>}
      {notice !== null && <p className="notice notice--warn">{notice}</p>}
      {view?.available === false && (
        <p className="muted">浏览器里没有宿主 IPC，这些诊断项不可用；用 Tauri 壳打开才有真实数据。</p>
      )}

      {view?.sqlite !== undefined && (
        <div className="kv-grid">
          <span>数据库</span>
          <code>{view.sqlite.path}</code>
          <span>journal / page</span>
          <code>
            {view.sqlite.journalMode} / {view.sqlite.pageSize}
          </code>
          <span>sqlite</span>
          <code>{view.sqlite.sqliteVersion}</code>
          <span>可写</span>
          <code>{view.sqlite.writable ? '是' : '否'}</code>
          <span>数据量</span>
          <code>
            角色 {view.sqlite.characters} · 会话 {view.sqlite.sessions} · 消息 {view.sqlite.messages}
          </code>
          {view.streamStats !== undefined && (
            <>
              <span>流式发射</span>
              <code>
                成功 {view.streamStats.ok} · 失败 {view.streamStats.errors.length}
              </code>
            </>
          )}
        </div>
      )}

      <div className="row">
        <button className="btn btn--ghost" disabled={!client.available} onClick={start}>
          重跑流式自检
        </button>
        <button className="btn btn--ghost" disabled={controller === null} onClick={() => controller?.abort()}>
          取消
        </button>
        <button className="btn btn--ghost" onClick={() => void client.load().then(setView)}>
          刷新
        </button>
        {streamed !== null && (
          <span className="muted">
            收到 {streamed.chunks} 片{streamed.cancelled ? '（已取消）' : '（已完成）'}
          </span>
        )}
      </div>
      {streamed !== null && streamed.text !== '' && <p className="stream">{streamed.text}</p>}
    </section>
  );
}
