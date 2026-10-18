import { useState, type ReactNode } from 'react';
import { Button } from '../../ui/components.tsx';
import type { ChatPreview } from '../../data/chat-client.ts';
import type { RequestLogEntry } from '../../data/request-log.ts';
import { RequestDetail } from './RequestDetail.tsx';

/**
 * 「历史请求」列表（B25）：最近 N 次请求的摘要，点开复用 `RequestDetail` 看真实 body。
 *
 * 纯展示组件：文案由调用方给（i18n 归 UI owner），这里不写死任何中英文；
 * 数据来自本机 `RequestLogPort`（不参与同步）。接线留给 ChatScreen/editor-character。
 */
export interface RequestHistoryLabels {
  title: string;
  empty: string;
  clear: string;
  ok: string;
  error: string;
  bytes: string;
  /** 耗时模板，例如 `"⏱ {{first}}ms → {{total}}ms"`；`{{first}}` 没有首字延迟时省略整段由调用方决定。 */
  timing: string;
}

export function RequestHistory({
  entries,
  onClear,
  labels,
}: {
  entries: readonly RequestLogEntry[];
  onClear: () => void;
  labels: RequestHistoryLabels;
}): ReactNode {
  const [openId, setOpenId] = useState<string | undefined>(undefined);
  const selectedIndex = entries.findIndex((entry) => entry.id === openId);
  const selected = selectedIndex < 0 ? undefined : entries[selectedIndex];
  const previous = selectedIndex < 0 ? undefined : entries[selectedIndex + 1];

  const previewOf = (entry: RequestLogEntry): ChatPreview => ({
    url: entry.url,
    body: entry.body,
    byteLength: entry.byteLength,
    model: entry.model,
  });

  return (
    <div className="request-history">
      <div className="row">
        <h3 className="trace__heading">{labels.title}</h3>
        <Button variant="ghost" disabled={entries.length === 0} onClick={onClear}>
          {labels.clear}
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="trace__meta">{labels.empty}</p>
      ) : (
        <ul className="trace__list">
          {entries.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="list-row"
                aria-expanded={entry.id === openId}
                onClick={() => setOpenId((current) => (current === entry.id ? undefined : entry.id))}
              >
                <span className="trace__name">
                  {entry.status === 'ok' ? '✓' : '✕'} {new Date(entry.at).toLocaleString()} · {entry.model}
                </span>
                <span className="trace__meta">
                  {labels.bytes.replace('{{bytes}}', String(entry.byteLength))} ·{' '}
                  {entry.status === 'ok' ? labels.ok : labels.error}
                </span>
              </button>
              {entry.totalMs !== undefined && (
                <span className="trace__meta">
                  {labels.timing
                    .replace('{{first}}', entry.firstDeltaMs === undefined ? '—' : String(entry.firstDeltaMs))
                    .replace('{{total}}', String(entry.totalMs))}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {selected !== undefined && <RequestDetail preview={previewOf(selected)} previousBody={previous?.body} />}
    </div>
  );
}
