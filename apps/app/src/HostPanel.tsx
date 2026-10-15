import { useEffect, useState } from 'react';
import { describeError } from './data/error-text.ts';
import { useT } from './i18n/context.tsx';
import type { OpLogAdmin } from './screens/screen-props.ts';
import type { HostClient, HostViewModel, StreamChunk } from './host-panel.ts';

export interface HostPanelProps {
  client: HostClient;
  /** op 日志统计与重建（M1 之后的事实源）；内存实现没有这个。 */
  ops?: OpLogAdmin | undefined;
}

/**
 * 开发者面板：宿主诊断 + 流式自检。
 *
 * 它**不再出现在主界面**（v0.1 里收进「设置 → 开发者」）。主界面是给人用的，
 * 诊断信息只该在需要排障时出现。
 */
export function HostPanel({ client, ops }: HostPanelProps) {
  const t = useT();
  const [view, setView] = useState<HostViewModel | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [streamed, setStreamed] = useState<{ text: string; chunks: number; cancelled: boolean } | null>(null);
  const [controller, setController] = useState<AbortController | null>(null);
  const [logStats, setLogStats] = useState<
    | {
        count: number;
        lastSeq: number;
        devices: number;
        bytes: number;
        corrupt: number;
        load?: { mode: 'snapshot' | 'replay'; ms: number; covered: number; tail: number; problem?: string };
      }
    | undefined
  >(undefined);
  const [rebuilt, setRebuilt] = useState<string | undefined>(undefined);
  const [snapshotNotice, setSnapshotNotice] = useState<string | undefined>(undefined);
  const [counts, setCounts] = useState<{ characters: number; sessions: number; messages: number } | undefined>(undefined);

  useEffect(() => {
    if (ops === undefined || ops.counts === undefined) return;
    void ops
      .counts()
      .then(setCounts)
      .catch(() => setCounts(undefined));
  }, [ops]);

  useEffect(() => {
    if (ops === undefined) return;
    void ops
      .stats()
      .then(setLogStats)
      // 开发者面板里最忌讳"点了没反应"：把失败原因摆出来
      .catch((cause: unknown) => setNotice(`${t('dev.oplog')}: ${describeError(cause)}`));
  }, [ops, t]);

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
        setNotice(describeError(cause));
      }
    })();
    // 只在挂载时跑一次；client 是稳定的单例
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = (): void => {
    const next = new AbortController();
    setController(next);
    void runStreamDemo(next.signal)
      .catch((cause: unknown) => setNotice(describeError(cause)))
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
            {counts === undefined
              ? t('dev.volume.loading')
              : t('dev.volume.counts', {
                  characters: t('count.characters', { count: counts.characters }),
                  sessions: t('count.sessions', { count: counts.sessions }),
                  messages: t('count.messages', { count: counts.messages }),
                })}
          </code>
          {view.sqlite.characters + view.sqlite.sessions + view.sqlite.messages > 0 && (
            <>
              <span>{t('dev.legacy')}</span>
              <code>
                {t('dev.volume.counts', {
                  characters: view.sqlite.characters,
                  sessions: view.sqlite.sessions,
                  messages: view.sqlite.messages,
                })}
              </code>
            </>
          )}
          {view.streamStats !== undefined && (
            <>
              <span>{t('dev.emits')}</span>
              <code>{t('dev.emits.counts', { ok: view.streamStats.ok, errors: view.streamStats.errors.length })}</code>
            </>
          )}
        </div>
      )}

      {logStats !== undefined && ops !== undefined && (
        <>
          <div className="kv-grid">
            <span>{t('dev.oplog')}</span>
            <code>
              {t('dev.oplog.stats', {
                count: logStats.count,
                kb: Math.round(logStats.bytes / 1024),
                devices: logStats.devices,
              })}
            </code>
            {logStats.corrupt > 0 && (
              <>
                <span>{t('dev.oplog.corrupt')}</span>
                <code>{logStats.corrupt}</code>
              </>
            )}
            {logStats.load !== undefined && (
              <>
                <span>{t('dev.oplog.load')}</span>
                <code>
                  {logStats.load.mode === 'snapshot'
                    ? t('dev.oplog.load.snapshot', { covered: logStats.load.covered, tail: logStats.load.tail, ms: logStats.load.ms })
                    : t('dev.oplog.load.replay', { ms: logStats.load.ms })}
                </code>
                {logStats.load.problem !== undefined && (
                  <>
                    <span>{t('dev.oplog.load.problem')}</span>
                    <code>{logStats.load.problem}</code>
                  </>
                )}
              </>
            )}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                // 丢掉内存状态、只靠日志重放：这就是"读模型是派生的"的现场证明
                void ops
                  .rebuild()
                  .then((result) =>
                    setRebuilt(
                      t('dev.oplog.rebuilt', {
                        ops: result.ops,
                        characters: result.characters,
                        sessions: result.sessions,
                        messages: result.messages,
                      }),
                    ),
                  )
                  .then(() => ops.stats().then(setLogStats))
                  .catch((cause: unknown) => setNotice(describeError(cause)));
              }}
            >
              {t('dev.oplog.rebuild')}
            </button>
            {rebuilt !== undefined && <span className="muted">{rebuilt}</span>}
          </div>
          {ops.createSnapshot !== undefined && (
            <div className="row">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  // 快照只加速下次冷启动；日志不动，所以这里没有"丢数据"的风险
                  setSnapshotNotice(undefined);
                  void ops
                    .createSnapshot?.()
                    .then((info) =>
                      setSnapshotNotice(t('dev.oplog.snapshot.created', { ops: info.opCount, digest: info.digest })),
                    )
                    .catch((cause: unknown) => setSnapshotNotice(describeError(cause)))
                    .then(() => ops.stats().then(setLogStats));
                }}
              >
                {t('dev.oplog.snapshot.create')}
              </button>
              {ops.clearSnapshot !== undefined && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setSnapshotNotice(undefined);
                    void ops
                      .clearSnapshot?.()
                      .then(() => setSnapshotNotice(t('dev.oplog.snapshot.cleared')))
                      .catch((cause: unknown) => setSnapshotNotice(describeError(cause)))
                      .then(() => ops.stats().then(setLogStats));
                  }}
                >
                  {t('dev.oplog.snapshot.clear')}
                </button>
              )}
              {snapshotNotice !== undefined && <span className="muted">{snapshotNotice}</span>}
            </div>
          )}
        </>
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
