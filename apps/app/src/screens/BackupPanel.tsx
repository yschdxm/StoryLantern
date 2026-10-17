import { useState, type ReactNode } from 'react';
import { Button, Field } from '../ui/components.tsx';
import { useT } from '../i18n/context.tsx';

/**
 * 「导出全部为一个文件」与**恢复**（§8.10 的最后一格）。
 *
 * 为什么值得一个独立面板：它与同步是**两件事** —— 计划里写着"独立提供'导出全部为一个文件'整体备份"，
 * 并且专门强调"远端 op 日志**不是** SQLite 备份"。所以这条路**不经过同步后端**：
 * 用户用系统选择器挑一个目录，文件写在那儿，网盘删了也不影响这份备份。
 *
 * 恢复方向同理：**不是"覆盖导入"** —— op 日志是 append-only 且 opId 幂等，
 * 所以恢复就是"把备份里那些本地还没有的 op 补进来"，并且照实报出"导入了 N 条、其中 M 条已存在"。
 * 这样即使选错了文件、导错了目录，也不会把现有数据弄丢。
 */
interface BackupAdmin {
  exportBackup?: () => Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  importBackup?: () => Promise<
    | { ok: true; name: string; total: number; applied: number; duplicates: number }
    | { ok: false; error: string }
  >;
}

export function BackupPanel(props: { sync: BackupAdmin }): ReactNode {
  const t = useT();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const canExport = typeof props.sync.exportBackup === 'function';
  const canImport = typeof props.sync.importBackup === 'function';

  const run = (action: () => Promise<{ ok: boolean } & Record<string, unknown>>): void => {
    setBusy(true);
    setNote('');
    void action()
      .then((result) => {
        if (!result.ok) {
          setNote(String(result.error ?? '失败'));
          return;
        }
        if (typeof result.applied === 'number') {
          const assets = typeof result.assets === 'number' ? result.assets : undefined;
          const assetsSkipped = typeof result.assetsSkipped === 'number' ? result.assetsSkipped : 0;
          setNote(
            assets === undefined
              ? t('backup.imported', { total: String(result.total), applied: String(result.applied), duplicates: String(result.duplicates) })
              : t('backup.importedAssets', {
                  total: String(result.total),
                  applied: String(result.applied),
                  duplicates: String(result.duplicates),
                  assets: String(assets),
                  skipped: String(assetsSkipped),
                }),
          );
          return;
        }
        setNote(t('backup.done', { name: String(result.name ?? '') }));
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('backup.section')}</h2>
      <Field label={t('backup.title')} hint={t('backup.hint')}>
        <Button
          disabled={busy || !canExport || props.sync.exportBackup === undefined}
          onClick={() => props.sync.exportBackup !== undefined && run(() => props.sync.exportBackup!())}
        >
          {t('backup.run')}
        </Button>
      </Field>
      <Field label={t('backup.restore')} hint={t('backup.restoreHint')}>
        <Button
          disabled={busy || !canImport || props.sync.importBackup === undefined}
          onClick={() => props.sync.importBackup !== undefined && run(() => props.sync.importBackup!())}
        >
          {t('backup.restoreRun')}
        </Button>
      </Field>
      {(!canExport || !canImport) && <p className="muted">{t('backup.unavailable')}</p>}
      {note !== '' && <p className="muted">{note}</p>}
    </section>
  );
}
