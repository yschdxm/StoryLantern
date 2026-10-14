import { useEffect, useState } from 'react';
import { useT } from './i18n/context.tsx';
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
  const t = useT();
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
    // 只在挂载时跑一次；client 是稳定的单例
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
    <section aria-label={t('settings.developer')}>
      <p className="muted">
        {t('dev.transport')}：{view === null ? '…' : view.available ? view.transport : t('dev.transport.none')}
        {view?.info !== undefined && ` · ${view.info.product} ${view.info.version} · ${view.info.os}/${view.info.arch}`}
        {view?.info !== undefined && ` · ${t('dev.methods', { count: view.methods.length })}`}
      </p>
      {view?.error !== undefined && <p className="notice notice--warn">{view.error}</p>}
      {notice !== null && <p className="notice notice--warn">{notice}</p>}
      {view?.available === false && <p className="muted">{t('dev.noHost')}</p>}

      {view?.sqlite !== undefined && (
        <div className="kv-grid">
          <span>{t('dev.db')}</span>
          <code>{view.sqlite.path}</code>
          <span>{t('dev.journal')}</span>
          <code>
            {view.sqlite.journalMode} / {view.sqlite.pageSize}
          </code>
          <span>{t('dev.sqlite')}</span>
          <code>{view.sqlite.sqliteVersion}</code>
          <span>{t('dev.writable')}</span>
          <code>{view.sqlite.writable ? t('dev.writable.yes') : t('dev.writable.no')}</code>
          <span>{t('dev.volume')}</span>
          <code>
            {t('dev.volume.counts', {
              characters: t('count.characters', { count: view.sqlite.characters }),
              sessions: t('count.sessions', { count: view.sqlite.sessions }),
              messages: t('count.messages', { count: view.sqlite.messages }),
            })}
          </code>
          {view.streamStats !== undefined && (
            <>
              <span>{t('dev.emits')}</span>
              <code>{t('dev.emits.counts', { ok: view.streamStats.ok, errors: view.streamStats.errors.length })}</code>
            </>
          )}
        </div>
      )}

      <div className="row">
        <button className="btn btn--ghost" disabled={!client.available} onClick={start}>
          {t('dev.rerun')}
        </button>
        <button className="btn btn--ghost" disabled={controller === null} onClick={() => controller?.abort()}>
          {t('dev.cancel')}
        </button>
        <button className="btn btn--ghost" onClick={() => void client.load().then(setView)}>
          {t('dev.refresh')}
        </button>
        {streamed !== null && (
          <span className="muted">
            {t('dev.chunks', {
              count: streamed.chunks,
              state: streamed.cancelled ? t('dev.chunks.cancelled') : t('dev.chunks.done'),
            })}
          </span>
        )}
      </div>
      {streamed !== null && streamed.text !== '' && <p className="stream">{streamed.text}</p>}
    </section>
  );
}
