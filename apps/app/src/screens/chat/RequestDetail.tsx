import { useState, type ReactNode } from 'react';
import type { ChatPreview } from '../../data/chat-client.ts';
import { useT } from '../../i18n/context.tsx';
import { Button } from '../../ui/components.tsx';
import { curlOf, diffLines } from './request-detail.ts';

/**
 * 请求详情：URL、**预览返回的那一份**真实 body、字节数、模型、复制与上一轮 diff。
 * 这里绝不重新拼 body：否则「看到的」和「发出去的」可能不是同一份。
 */
export function RequestDetail({
  preview,
  previousBody,
  postHistory,
  authorsNote,
}: {
  preview: ChatPreview;
  previousBody?: string | undefined;
  postHistory?: string | undefined;
  /** 只有请求对象真的带了 authorsNote 才显示（没有就只靠系统提示块，不编造）。 */
  authorsNote?: string | undefined;
}): ReactNode {
  const t = useT();
  const [feedback, setFeedback] = useState<'ok' | 'failed' | undefined>(undefined);

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback('ok');
    } catch {
      setFeedback('failed');
    }
  };

  const changes = diffLines(previousBody, preview.body);
  const changed = changes.filter((line) => line.kind !== 'same').length;

  return (
    <div className="request-detail">
      <p className="trace__line">{t('chat.request.model', { model: preview.model })}</p>
      <p className="trace__line">
        {t('chat.request.url')}：{preview.url}
      </p>
      <p className="trace__meta">{t('chat.request.bytes', { bytes: preview.byteLength })}</p>
      <div className="row">
        <Button variant="ghost" onClick={() => void copy(preview.body)}>
          {t('chat.request.copy.json')}
        </Button>
        <Button variant="ghost" onClick={() => void copy(curlOf(preview.url, preview.body))}>
          {t('chat.request.copy.curl')}
        </Button>
      </div>
      {feedback !== undefined && (
        <p className={feedback === 'ok' ? 'notice notice--ok' : 'notice notice--warn'}>
          {feedback === 'ok' ? t('chat.request.copy.ok') : t('chat.request.copy.failed')}
        </p>
      )}
      <p className="field__hint">{t('chat.request.masking')}</p>
      {postHistory !== undefined && postHistory !== '' && (
        <>
          <h3 className="trace__heading">{t('chat.request.postHistory')}</h3>
          <pre className="request-detail__pre">{postHistory}</pre>
        </>
      )}
      {authorsNote !== undefined && authorsNote !== '' && (
        <>
          <h3 className="trace__heading">{t('chat.request.authorsNote')}</h3>
          <pre className="request-detail__pre">{authorsNote}</pre>
        </>
      )}
      <h3 className="trace__heading">{t('chat.request.body')}</h3>
      <pre className="request-detail__body">{preview.body}</pre>
      <h3 className="trace__heading">
        {previousBody === undefined
          ? t('chat.request.diff.first')
          : changed === 0
            ? t('chat.request.diff.same')
            : t('chat.request.diff', { count: changed })}
      </h3>
      {previousBody !== undefined && changed > 0 && (
        <div className="request-detail__diff">
          {changes.map((line, index) => (
            <div key={`${line.kind}-${String(index)}`} className={`request-detail__line request-detail__line--${line.kind}`}>
              {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
              {line.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
