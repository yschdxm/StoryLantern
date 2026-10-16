import { useState, type ReactNode } from 'react';
import { Button, Field } from '../ui/components.tsx';
import { useT } from '../i18n/context.tsx';

/**
 * 「导出全部为一个文件」（§8.10 的最后一格）：把**整份 op 日志**写成一个自包含备份。
 *
 * 为什么值得一个独立面板：它与同步是**两件事** —— 计划里写着"独立提供'导出全部为一个文件'整体备份"，
 * 并且专门强调"远端 op 日志**不是** SQLite 备份"。所以这条路**不经过同步后端**：
 * 用户用系统选择器挑一个目录，文件写在那儿，网盘删了也不影响这份备份。
 *
 * 恢复方式（写在界面上，免得用户拿到文件不知道怎么用）：它是一串 op，重放即可重建状态。
 */
export function BackupPanel(props: { sync: { exportBackup?: () => Promise<{ ok: true; name: string } | { ok: false; error: string }> } }): ReactNode {
  const t = useT();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const available = typeof props.sync.exportBackup === 'function';

  const run = (): void => {
    if (props.sync.exportBackup === undefined) return;
    setBusy(true);
    setNote('');
    void props.sync
      .exportBackup()
      .then((result) => setNote(result.ok ? t('backup.done', { name: result.name }) : result.error))
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('backup.section')}</h2>
      <Field label={t('backup.title')} hint={t('backup.hint')}>
        <Button disabled={busy || !available} onClick={run}>
          {t('backup.run')}
        </Button>
      </Field>
      {!available && <p className="muted">{t('backup.unavailable')}</p>}
      {note !== '' && <p className="muted">{note}</p>}
    </section>
  );
}
