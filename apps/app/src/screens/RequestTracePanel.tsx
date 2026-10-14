import type { ReactNode } from 'react';
import { useT } from '../i18n/context.tsx';
import type { PromptTrace } from '../data/prompt.ts';
import { Sheet } from '../ui/components.tsx';

/**
 * 「本次请求」面板：把"模型到底看到了什么、裁了什么、为什么"如实摊开。
 *
 * 数据全部来自 `prompt.ts` 产出的 trace（块与理由由组装管线给出）与调用时的实测耗时；
 * 这里**不做**任何推断或美化：没有的字段就显示 `—`。
 */

/** 一次模型尝试（多模型路由的回退链里，谁试过、成没成、多久）。 */
export interface ModelAttempt {
  label: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface RequestTraceState {
  trace: PromptTrace;
  startedAt: number;
  firstDeltaMs?: number;
  totalMs?: number;
  attempts: ModelAttempt[];
}

export function RequestTracePanel({
  open,
  state,
  modelLabel,
  onClose,
}: {
  open: boolean;
  state: RequestTraceState | undefined;
  /** 当前默认模型名（设置里的值）；面板只在没走具体配置时用它兜底。 */
  modelLabel: string;
  onClose: () => void;
}): ReactNode {
  const t = useT();

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
                  {block.included ? '' : ` · ${t('chat.trace.block.omitted')}`}
                </span>
                {block.reason !== '' && <span className="trace__reason">{block.reason}</span>}
              </li>
            ))}
          </ul>

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

          <p className="trace__line">
            {t('chat.trace.totals', {
              system: state.trace.systemChars,
              messages: state.trace.historyIncluded,
              chars: state.trace.messageChars,
              tokens: state.trace.usedTokens,
              budget: state.trace.budgetTokens === 0 ? '—' : state.trace.budgetTokens,
            })}
          </p>
        </div>
      )}
    </Sheet>
  );
}
