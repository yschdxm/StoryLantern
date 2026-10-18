import type { ReactNode } from 'react';
import type { Message } from '../../data/types.ts';
import { useT } from '../../i18n/context.tsx';
import { Sheet } from '../../ui/components.tsx';
import { previewOfSource } from './display.ts';

/** 长按消息 →「查看详情」：模型、token（标注估算）、耗时、思考全文、引用列表。 */
export function MessageDetail({
  message,
  sourceOf,
  open,
  onClose,
}: {
  message: Message | undefined;
  sourceOf: (messageId: string) => string | undefined;
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const meta = message?.meta;
  return (
    <Sheet open={open} title={t('chat.detail.title')} onClose={onClose}>
      {message !== undefined && (
        <div className="msg-detail">
          {message.status === 'error' && <p className="notice notice--warn">{t('chat.detail.error')}：{message.content}</p>}
          {message.status === 'stopped' && <p className="notice">{t('chat.detail.status.stopped')}</p>}
          {meta === undefined ? (
            <p className="muted">{t('chat.detail.none')}</p>
          ) : (
            <>
              <p className="trace__line">
                {t('chat.detail.model')}：
                {t('chat.detail.model.value', {
                  label: meta.modelLabel ?? '—',
                  id: meta.modelId ?? '—',
                })}
              </p>
              <p className="trace__line">
                {t('chat.detail.tokens')}：
                {t('chat.detail.tokens.value', {
                  prompt: meta.tokens?.prompt ?? '—',
                  completion: meta.tokens?.completion ?? '—',
                })}
              </p>
              <p className="trace__line">
                {t('chat.detail.timing')}：
                {t('chat.detail.timing.value', {
                  first: meta.timing?.firstDeltaMs ?? '—',
                  total: meta.timing?.totalMs ?? '—',
                })}
              </p>
              {meta.reasoning !== undefined && meta.reasoning !== '' && (
                <>
                  <h3 className="trace__heading">{t('chat.detail.reasoning')}</h3>
                  <p className="msg__reasoning-text">{meta.reasoning}</p>
                </>
              )}
              <h3 className="trace__heading">{t('chat.detail.citations')}</h3>
              {(meta.citations ?? []).length === 0 ? (
                <p className="muted">{t('chat.detail.citations.none')}</p>
              ) : (
                <ul className="trace__list">
                  {(meta.citations ?? []).map((citation) => (
                    <li key={citation.index}>
                      {citation.resolved && citation.messageId !== undefined
                        ? t('chat.detail.citation.line', {
                            index: citation.index,
                            target: previewOfSource(sourceOf(citation.messageId)) ?? citation.messageId,
                          })
                        : t('chat.detail.citation.missing', { index: citation.index })}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
