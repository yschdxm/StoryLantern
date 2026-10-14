import { useEffect, useState } from 'react';
import type { HostClient, HostViewModel, StreamChunk } from './host-panel.ts';

export interface HostPanelProps {
  client: HostClient;
}

/**
 * 宿主面板：一屏看"壳到底提供了什么、SQLite 是否真的在写、流式是否真的在推"。
 *
 * 它也是移动端 spike 的验收面：在 Android 上这些数字都来自真实的 Rust 侧
 * （`apps/shell/src-tauri/src/{wire,store}.rs`），而不是前端模拟。
 */
export function HostPanel({ client }: HostPanelProps) {
  const [view, setView] = useState<HostViewModel | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [streamed, setStreamed] = useState<{ text: string; chunks: number; cancelled: boolean; planned?: number } | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);

  const reload = async (): Promise<void> => {
    setView(await client.load());
  };

  const runStreamDemo = async (signal: AbortSignal): Promise<void> => {
    setStreamed({ text: '', chunks: 0, cancelled: false });
    const result = await client.streamDemo(
      'Story Lantern 的流式通道',
      (chunk: StreamChunk) => {
        const planned = chunk.planned;
        if (typeof planned === 'number') {
          // 元帧：宿主声明本次会推几片。先取出成常量再进闭包，否则收窄会丢。
          setStreamed((current) => ({ text: current?.text ?? '', chunks: current?.chunks ?? 0, cancelled: false, planned }));
          return;
        }
        setStreamed((current) => ({
          text: (current?.text ?? '') + chunk.text,
          chunks: (current?.chunks ?? 0) + 1,
          cancelled: false,
          ...(current?.planned === undefined ? {} : { planned: current.planned }),
        }));
      },
      { signal },
    );
    setStreamed({
      text: result.text,
      chunks: result.chunks,
      cancelled: result.cancelled,
      ...(result.planned === undefined ? {} : { planned: result.planned }),
    });
    // 流完之后刷新一次：发射统计要能看到刚才这一轮的结果
    setView(await client.load());
  };

  useEffect(() => {
    void (async () => {
      const loaded = await client.load();
      setView(loaded);
      // 宿主自检：可用时自动跑一次流式探针。
      // 好处是"IPC 通道是否真的在推分片"打开面板就能看到，不必依赖人去点按钮。
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

  const guard = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const runStream = (): void => {
    const next = new AbortController();
    setController(next);
    void guard(() => runStreamDemo(next.signal)).finally(() => setController(null));
  };

  const notes = view?.notes ?? [];

  return (
    <section className="panel panel--wide" aria-label="Host">
      <h2 className="panel__title">
        HOST · {view === null ? '…' : view.available ? view.transport : '浏览器（无宿主 IPC）'}
      </h2>

      {view?.error !== undefined && <p className="notice notice--warn">{view.error}</p>}
      {notice !== null && <p className="notice notice--warn">{notice}</p>}

      {view?.available === false && (
        <p className="panel__meta">
          当前是纯浏览器运行：没有 IPC 通道、也没有宿主 SQLite。用 Tauri 壳（桌面/Android）打开时这里会显示真实数据。
        </p>
      )}

      {view?.info !== undefined && (
        <p className="panel__meta">
          {view.info.product} {view.info.version} · {view.info.os}/{view.info.arch}
          {' · '}
          方法 {view.methods.length} 个
        </p>
      )}

      {view?.sqlite !== undefined && (
        <div className="host-block">
          <h3 className="host-block__title">SQLite</h3>
          <ul className="kv">
            <li>
              <span>journal</span>
              <code>{view.sqlite.journalMode}</code>
            </li>
            <li>
              <span>page_size</span>
              <code>{view.sqlite.pageSize}</code>
            </li>
            <li>
              <span>sqlite</span>
              <code>{view.sqlite.sqliteVersion}</code>
            </li>
            <li>
              <span>可写</span>
              <code>{view.sqlite.writable ? '是' : '否'}</code>
            </li>
            <li>
              <span>路径</span>
              <code className="kv__path">{view.sqlite.path}</code>
            </li>
          </ul>
        </div>
      )}

      <div className="host-block">
        <h3 className="host-block__title">便签（存在宿主 SQLite 里，重启后仍在）</h3>
        <div className="row">
          <input
            className="field__control field__control--grow"
            placeholder="写点什么，然后点「写入」"
            value={draft}
            disabled={!client.available || busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            className="btn"
            disabled={!client.available || busy || draft.trim() === ''}
            onClick={() =>
              void guard(async () => {
                await client.addNote(draft);
                setDraft('');
                await reload();
              })
            }
          >
            写入
          </button>
        </div>
        {notes.length === 0 ? (
          <p className="panel__meta">（还没有便签）</p>
        ) : (
          <ul className="notes">
            {notes.map((note) => (
              <li key={note.id} className="notes__row">
                <span className="notes__body">{note.body}</span>
                <span className="notes__meta">#{note.id}</span>
                <button
                  className="btn btn--ghost"
                  disabled={busy}
                  onClick={() =>
                    void guard(async () => {
                      await client.deleteNote(note.id);
                      await reload();
                    })
                  }
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="host-block">
        <h3 className="host-block__title">流式通道（Channel 分片 + 取消）</h3>
        {view?.streamStats !== undefined && (
          <p className="panel__meta">
            宿主发射统计（加载时快照）：成功 {view.streamStats.ok} 次 · 失败 {view.streamStats.errors.length} 次
            {view.streamStats.errors.length > 0 && <> · {view.streamStats.errors[0]}</>}
          </p>
        )}
        <div className="row">
          <button className="btn" disabled={!client.available || busy} onClick={runStream}>
            重新流式
          </button>
          <button className="btn btn--ghost" disabled={controller === null} onClick={() => controller?.abort()}>
            取消
          </button>
          {streamed !== null && (
            <span className="panel__meta">
              {streamed.planned === undefined ? '' : `宿主声明 ${streamed.planned} 片 · `}
              收到 {streamed.chunks} 片{streamed.cancelled ? '（已取消）' : '（已完成）'}
            </span>
          )}
        </div>
        {streamed !== null && <p className="stream">{streamed.text || '…'}</p>}
      </div>

      <button className="btn btn--ghost" disabled={busy} onClick={() => void reload()}>
        刷新
      </button>
    </section>
  );
}
