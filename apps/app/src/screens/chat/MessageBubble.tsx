import { useState, type ReactNode } from 'react';
import type { Message, MessageCitation } from '../../data/types.ts';
import { useT } from '../../i18n/context.tsx';
import { displayContentOf, previewOfSource } from './display.ts';

/** 引用 chip 列表：resolved 的可点开来源预览；resolved:false 明确显示「无法对应」，不静默丢。 */
function Citations({
  citations,
  sourceOf,
}: {
  citations: readonly MessageCitation[];
  sourceOf: (messageId: string) => string | undefined;
}): ReactNode {
  const t = useT();
  const [openIndex, setOpenIndex] = useState<number | undefined>(undefined);
  if (citations.length === 0) return null;
  const unresolved = citations.filter((citation) => !citation.resolved).length;
  const open = citations.find((citation) => citation.index === openIndex);
  const preview = open?.messageId === undefined ? undefined : previewOfSource(sourceOf(open.messageId));
  return (
    <div className="msg__citations">
      {citations.map((citation) =>
        citation.resolved && citation.messageId !== undefined ? (
          <button
            key={citation.index}
            type="button"
            className={citation.index === openIndex ? 'citation-chip citation-chip--active' : 'citation-chip'}
            onClick={(event) => {
              event.stopPropagation();
              setOpenIndex(citation.index === openIndex ? undefined : citation.index);
            }}
          >
            [{citation.index}]
          </button>
        ) : (
          <span key={citation.index} className="citation-chip citation-chip--missing">
            [{citation.index}] {t('chat.citation.missing')}
          </span>
        ),
      )}
      {unresolved > 0 && <span className="msg__meta">{t('chat.citation.unresolved', { count: unresolved })}</span>}
      {preview !== undefined && <p className="msg__citation-preview">{t('chat.citation.preview', { text: preview })}</p>}
    </div>
  );
}

/** 已落库消息的正文 + 思考过程 + 引用（折叠块默认收起）。 */
export function MessageContent({
  message,
  sourceOf,
}: {
  message: Message;
  sourceOf: (messageId: string) => string | undefined;
}): ReactNode {
  const t = useT();
  const reasoning = message.meta?.reasoning ?? '';
  return (
    <>
      <span className="msg__text">{displayContentOf(message) === '' ? '…' : displayContentOf(message)}</span>
      <Citations citations={message.meta?.citations ?? []} sourceOf={sourceOf} />
      {reasoning !== '' && (
        <details className="msg__reasoning" onClick={(event) => event.stopPropagation()}>
          <summary>{t('chat.reasoning.title', { count: reasoning.length })}</summary>
          <p className="msg__reasoning-text">{reasoning}</p>
        </details>
      )}
    </>
  );
}

/** 流式中的气泡：正文实时累积；思考链单独折叠，没有就不显示占位。 */
export function StreamingContent({ text, reasoning }: { text: string; reasoning: string }): ReactNode {
  const t = useT();
  return (
    <>
      <span className="msg__text">{text === '' ? '…' : text}</span>
      {reasoning !== '' && (
        <details className="msg__reasoning">
          <summary>{t('chat.reasoning.streaming', { count: reasoning.length })}</summary>
          <p className="msg__reasoning-text">{reasoning}</p>
        </details>
      )}
    </>
  );
}
