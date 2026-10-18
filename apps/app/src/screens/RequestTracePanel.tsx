import { useState, type ReactNode } from 'react';
import { useT } from '../i18n/context.tsx';
import type { ActivationEntry } from '../../../../packages/cards/src/index.ts';
import type { ChatCall, ChatPreview } from '../data/chat-client.ts';
import type { PromptTraceV2 } from '../data/prompt-v2.ts';
import { Button, Sheet } from '../ui/components.tsx';
import type { RequestLogEntry } from '../data/request-log.ts';
import { RequestDetail } from './chat/RequestDetail.tsx';
import { RequestHistory, type RequestHistoryLabels } from './chat/RequestHistory.tsx';

/**
 * 「本次请求」面板：把"模型到底看到了什么、裁了什么、为什么"如实摊开。
 *
 * 数据全部来自 `prompt-v2.ts` 产出的 trace（块与理由由组装管线给出）与调用时的实测耗时；
 * 这里**不做**任何推断或美化：没有的字段就显示 `—`。
 */

/** 一次模型尝试（多模型路由的回退链里，谁试过、成没成、多久）。 */
export interface ModelAttempt {  label: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface RequestTraceState {
  trace: PromptTraceV2;
  startedAt: number;
  firstDeltaMs?: number;
  totalMs?: number;
  attempts: ModelAttempt[];
  /** 没有参与本次装配的卡片及原因（库级停用 / 资源池外 / 不在场 / 无实例…）。 */
  inactiveCards?: readonly ActivationEntry[];
  /** 实际要发出去的调用（Inspector 用；与 preview.body 一一对应）。 */
  request?: ChatCall;
  /** `chat.preview` 返回的真实请求（URL/body/字节数/模型）；不自己再拼一份。 */
  preview?: ChatPreview;
  /** 上一轮的请求体：用于行级 diff；第一轮没有。 */
  previousBody?: string;
  /** 预览失败的原因（面板要如实显示，不假装有详情）。 */
  previewError?: string;
}

export function RequestTracePanel({
  open,
  state,
  modelLabel,
  onClose,
  history,
  historyError,
  onClearHistory,
}: {
  open: boolean;
  state: RequestTraceState | undefined;
  /** 当前默认模型名（设置里的值）；面板只在没走具体配置时用它兜底。 */
  modelLabel: string;
  onClose: () => void;
  /** B25 本机审计：最近 20 次请求（新的在前）；不传就没有历史入口。 */
  history?: readonly RequestLogEntry[] | undefined;
  historyError?: string | undefined;
  onClearHistory?: (() => void) | undefined;
}): ReactNode {
  const t = useT();
  const [detailOpen, setDetailOpen] = useState(false);
  // ChatCall 目前没有 authorsNote（作者注在系统提示块里）；只有调用方真的带上时才显示。
  const requestAuthorsNote = (state?.request as (ChatCall & { authorsNote?: string }) | undefined)?.authorsNote;
  const historyLabels: RequestHistoryLabels = {
    title: t('chat.request.history.title'),
    empty: t('chat.request.history.empty'),
    clear: t('chat.request.history.clear'),
    ok: t('chat.request.history.ok'),
    error: t('chat.request.history.error'),
    bytes: t('chat.request.history.bytes'),
    timing: t('chat.request.history.timing'),
  };

  return (
    <Sheet open={open} title={t('chat.trace.title')} onClose={onClose}>
      {state !== undefined && (
        <div className="trace">
          <p className="trace__line">{t('chat.trace.params', { model: modelLabel })}</p>
          <p className="trace__line">
            {t('chat.trace.timing', {
              first: state.firstDeltaMs === undefined ? '—' : state.firstDeltaMs,
              total: state.totalMs === undefined ? '—' : state.totalMs,
            })}
          </p>

          <Button variant="ghost" disabled={state.preview === undefined} onClick={() => setDetailOpen((value) => !value)}>
            {t('chat.request.button')}
          </Button>
          {state.previewError !== undefined && (
            <p className="notice notice--warn">{t('chat.request.unavailable', { message: state.previewError })}</p>
          )}
          {detailOpen && state.preview !== undefined && (
            <RequestDetail
              preview={state.preview}
              previousBody={state.previousBody}
              postHistory={state.request?.postHistory}
              authorsNote={requestAuthorsNote}
            />
          )}

          {state.attempts.length > 0 && (
            <>
              <h3 className="trace__heading">{t('chat.trace.attempts')}</h3>
              <ul className="trace__list">
                {state.attempts.map((attempt, index) => (
                  <li key={`${attempt.label}-${index}`} className={attempt.ok ? undefined : 'trace__item--omitted'}>
                    <span className="trace__name">
                      {attempt.ok ? '✓' : '✕'} {attempt.label}
                    </span>
                    <span className="trace__meta">{t('chat.trace.attempt.ms', { ms: attempt.ms })}</span>
                    {attempt.error !== undefined && <span className="trace__reason">{attempt.error}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="trace__heading">{t('chat.trace.blocks')}</h3>
          {!state.trace.pipeline && <p className="notice notice--warn">{t('chat.trace.noPipeline')}</p>}
          <ul className="trace__list">
            {state.trace.blocks.map((block) => (
              <li key={block.id} className={block.included ? undefined : 'trace__item--omitted'}>
                <span className="trace__name">{t(`chat.trace.block.${block.kind}`)}</span>
                <span className="trace__meta">
                  {t('chat.trace.block.meta', { chars: block.chars, tokens: block.estimatedTokens })}
                  {block.chars === 0
                    ? ` · ${t('chat.trace.block.empty')}`
                    : block.included
                      ? ''
                      : ` · ${t('chat.trace.block.omitted')}`}
                </span>
                {block.source !== undefined && (
                  <span className="trace__meta">
                    {t('chat.trace.source', {
                      type: t(`chat.trace.source.${block.source.type}`),
                      label: block.source.label ?? block.source.id ?? '—',
                    })}
                  </span>
                )}
                {block.truncated === true && (
                  <span className="trace__meta">{t('chat.trace.block.truncated', { chars: block.droppedChars ?? 0 })}</span>
                )}
                {block.reason !== '' && <span className="trace__reason">{block.reason}</span>}
              </li>
            ))}
          </ul>

          {state.trace.memory.length > 0 && (
            <>
              <h3 className="trace__heading">{t('chat.trace.memory')}</h3>
              <ul className="trace__list">
                {state.trace.memory.map((item) => (
                  <li key={item.memory.id}>
                    <span className="trace__name">
                      {item.matchedKeys.length > 0 ? item.matchedKeys.join('、') : t('chat.trace.memory.constant')}
                    </span>
                    <span className="trace__meta">{item.memory.text.slice(0, 60)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {state.trace.lore.length > 0 && (
            <>
              <h3 className="trace__heading">{t('chat.trace.lore')}</h3>
              <ul className="trace__list">
                {state.trace.lore.map((entry) => (
                  <li key={`${entry.bookId}:${entry.entryId}`}>
                    <span className="trace__name">{entry.matchedKeys.join('、') || entry.bookName}</span>
                    <span className="trace__meta">{entry.content.slice(0, 40)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="trace__heading">{t('chat.trace.excluded', { count: state.trace.excluded.length })}</h3>
          {state.trace.excluded.length === 0 ? (
            <p className="trace__meta">{t('chat.trace.excluded.none')}</p>
          ) : (
            <ul className="trace__list">
              {state.trace.excluded.slice(0, 8).map((item, index) => (
                <li key={`${item.role}-${index}`}>
                  <span className="trace__name">{t(`chat.trace.reason.${item.reason}`, { limit: state.trace.historyLimit })}</span>
                  <span className="trace__meta">{item.preview === '' ? '—' : item.preview}</span>
                </li>
              ))}
            </ul>
          )}

          {(state.inactiveCards?.length ?? 0) > 0 && (
            <>
              <h3 className="trace__heading">{t('chat.trace.inactive', { count: state.inactiveCards?.length ?? 0 })}</h3>
              <ul className="trace__list">
                {(state.inactiveCards ?? []).slice(0, 8).map((entry) => (
                  <li key={entry.id}>
                    <span className="trace__name">{entry.id}</span>
                    <span className="trace__meta">{t(`chat.trace.inactive.${entry.code}`)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="trace__line">
            {t('chat.trace.totals', {
              system: state.trace.systemChars,
              messages: state.trace.historyIncluded,
              chars: state.trace.messageChars,
              tokens: state.trace.usedTokens,
              budget: state.trace.budgetTokens === 0 ? '—' : state.trace.budgetTokens,
            })}
          </p>
          {state.trace.rulesOmitted > 0 && (
            <p className="notice notice--warn">{t('chat.trace.rulesOmitted', { count: state.trace.rulesOmitted })}</p>
          )}
          {state.trace.loreDropped > 0 && (
            <p className="trace__meta">{t('chat.trace.loreDropped', { count: state.trace.loreDropped })}</p>
          )}
          {state.trace.loreOutletDropped > 0 && (
            <p className="notice notice--warn">
              {t('chat.trace.outletDropped', {
                count: state.trace.loreOutletDropped,
                names: state.trace.loreOutletsIgnored.length === 0 ? '' : `（${state.trace.loreOutletsIgnored.join('、')}）`,
              })}
            </p>
          )}
          {historyError !== undefined && (
            <p className="notice notice--warn">{t('chat.request.history.failed', { message: historyError })}</p>
          )}
          {history !== undefined && (
            <div data-testid="request-history">
              <RequestHistory entries={history} labels={historyLabels} onClear={onClearHistory ?? (() => undefined)} />
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
