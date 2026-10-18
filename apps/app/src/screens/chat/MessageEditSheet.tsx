import { useEffect, useState, type ReactNode } from 'react';
import { describeError } from '../../data/error-text.ts';
import type { Message } from '../../data/types.ts';
import { useT } from '../../i18n/context.tsx';
import { Button, Sheet, TextArea } from '../../ui/components.tsx';

/** 编辑消息正文（B15）：保存为**新版本**，旧版由数据层保留；空内容/失败都可见。 */
export function MessageEditSheet({
  message,
  onSave,
  onClose,
}: {
  message: Message | undefined;
  onSave: (content: string) => Promise<boolean>;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const [text, setText] = useState(message?.content ?? '');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(message?.content ?? '');
    setError(undefined);
  }, [message?.id, message?.content]);

  const save = async (): Promise<void> => {
    const content = text.trim();
    if (content === '') {
      setError(t('chat.edit.empty'));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      if (await onSave(content)) onClose();
      else setError(t('chat.edit.failed', { message: '—' }));
    } catch (cause) {
      setError(t('chat.edit.failed', { message: describeError(cause) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={message !== undefined} title={t('chat.edit.title')} onClose={onClose}>
      <div className="sheet__form">
        <TextArea value={text} onChange={setText} rows={5} />
        {error !== undefined && <p className="notice notice--warn">{error}</p>}
        <Button block disabled={saving || text.trim() === ''} onClick={() => void save()}>
          {saving ? t('chat.edit.saving') : t('chat.edit.save')}
        </Button>
      </div>
    </Sheet>
  );
}
