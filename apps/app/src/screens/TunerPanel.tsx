import { useEffect, useState, type ReactNode } from 'react';
import { Button, Field } from '../ui/components.tsx';
import { useT } from '../i18n/context.tsx';
import type { TunerStore, TunerSuggestion } from '../data/op-tuner-store.ts';

/**
 * 调优助手面板（M5 / ADR-0003：侧信道）。
 *
 * 界面刻意只做三件事：**看建议**、**点应用**、**点撤销**。没有"自动应用"、没有定时刷新、
 * 没有"一键全部应用" —— 因为"0 条无审批写入"这条判据的意义就在于：写下去这件事必须由人点头。
 *
 * 面板本身不碰 op：它只调 `TunerStore`，而那个仓储在应用时**按 id 重新推导**建议，
 * 过期就拒绝（状态可能在你盯着屏幕的这几分钟里变了）。
 */
export function TunerPanel(props: { tuner: TunerStore }): ReactNode {
  const t = useT();
  const [items, setItems] = useState<TunerSuggestion[]>([]);
  const [undoable, setUndoable] = useState<TunerSuggestion | undefined>(undefined);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    void props.tuner
      .suggest()
      .then(setItems)
      .catch(() => setItems([]));
    void props.tuner
      .pendingUndo()
      .then(setUndoable)
      .catch(() => setUndoable(undefined));
  };

  useEffect(refresh, []);

  const apply = (id: string): void => {
    setBusy(true);
    setNote('');
    void props.tuner
      .apply(id)
      .then((result) => {
        setNote(result.ok ? t('tuner.applied') : result.error);
        refresh();
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  const undo = (): void => {
    setBusy(true);
    setNote('');
    void props.tuner
      .undo()
      .then((result) => {
        setNote(result.ok ? t('tuner.undone') : result.error);
        refresh();
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('tuner.section')}</h2>
      <Field label={t('tuner.title')} hint={t('tuner.hint')}>
        <Button disabled={busy} onClick={refresh}>
          {t('tuner.refresh')}
        </Button>
      </Field>

      {items.length === 0 && <p className="muted">{t('tuner.none')}</p>}
      {items.map((item) => (
        <div key={item.id} className="settings-group">
          <p>
            <strong>{item.title}</strong>
          </p>
          <p className="muted">{item.reason}</p>
          {item.evidence.map((line) => (
            <p key={line} className="muted">
              {line}
            </p>
          ))}
          <Button disabled={busy} onClick={() => apply(item.id)}>
            {t('tuner.apply')}
          </Button>
        </div>
      ))}

      {undoable !== undefined && (
        <>
          <p className="muted">{undoable.title}</p>
          <Button disabled={busy} onClick={undo}>
            {t('tuner.undo')}
          </Button>
        </>
      )}

      {note !== '' && <p className="muted">{note}</p>}
    </section>
  );
}
