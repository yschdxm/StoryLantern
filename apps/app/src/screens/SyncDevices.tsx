import { useEffect, useState, type ReactNode } from 'react';
import { describeError } from '../data/error-text.ts';
import { useT } from '../i18n/context.tsx';
import type { SyncAdmin, SyncDevice } from './screen-props.ts';
import { Banner, Button, ConfirmDialog, Field, ListRow, Sheet, SheetItem, TextInput } from '../ui/components.tsx';

/**
 * 设备名单与回收。
 *
 * 两件事都必须"看得见"，因为它们决定了**别人的数据会不会被删掉**：
 *  - 名单：配对即登记；**吊销是显式动作**，界面要先警告"它离线期间的新数据将不再保留"；
 *  - 回收：默认只**分析**，把"会删哪些、为什么"摊开；真正执行要再确认一次。
 *
 * 判定依据在 `sync-core/gc.ts`：名单内全部活跃设备都已并入 + 超过宽限期，
 * 而且只会回收**本机自己发布的段**（对端段没有可信的发布时间记录，保守跳过）。
 */
export function SyncDevices({
  sync,
  safPick,
  safSync,
  graceSync,
}: {
  sync: SyncAdmin;
  safPick?: SyncAdmin['safPick'];
  /** 用系统选择器选中的目录做同步目录的开关。 */
  safSync?: { value: boolean; onChange: (next: boolean) => void } | undefined;
  /** GC 宽限期（天）：留空 = 默认 30 天。 */
  graceSync?: { value: string; onChange: (next: string) => void } | undefined;
}): ReactNode {
  const t = useT();
  const [devices, setDevices] = useState<SyncDevice[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [confirmRevoke, setConfirmRevoke] = useState<string | undefined>(undefined);
  /** 永久禁用（黑名单）：与临时吊销分开，确认文案里写清代价。 */
  const [confirmBan, setConfirmBan] = useState<string | undefined>(undefined);
  const [analysis, setAnalysis] = useState<{ candidates: string[]; moved: string[]; reasons: string[] } | undefined>(undefined);
  const [confirmCollect, setConfirmCollect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | undefined>(undefined);
  /** SAF 选择器结果：现在只做到"选中并记住"，界面必须说清。 */
  const [safNote, setSafNote] = useState<string | undefined>(undefined);

  const reload = async (): Promise<void> => {
    try {
      setDevices(await sync.devices());
    } catch (cause) {
      setError(describeError(cause));
    }
  };

  useEffect(() => {
    void reload();
    // 只在挂载时拉一次：名单变化要么来自同步，要么来自本页的吊销操作
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const menu = devices?.find((device) => device.deviceId === menuFor);
  const revoking = devices?.find((device) => device.deviceId === confirmRevoke);
  const banning = devices?.find((device) => device.deviceId === confirmBan);

  return (
    <>
      {error !== undefined && <Banner tone="error">{error}</Banner>}
      {note !== undefined && <Banner tone="info">{note}</Banner>}

      {/* 系统目录选择器：宿主插件缺失时也要说清楚，而不是悄悄不显示 */}
      {true && (
        <>
          <div className="row">
            <Button
              variant="ghost"
              onClick={() => {
                if (safPick === undefined) {
                  setSafNote(t('settings.sync.saf.unavailable'));
                  return;
                }
                void safPick().then((result) => {
                  if ('error' in result) {
                    setSafNote(result.error);
                    return;
                  }
                  setSafNote(t('settings.sync.saf.picked', { name: result.name === '' ? result.uri : result.name }));
                });
              }}
            >
              {t('settings.sync.saf.pick')}
            </Button>
          </div>
          {safNote !== undefined && <p className="muted">{safNote}</p>}
          {safSync !== undefined && (
            <label className="row">
              <input
                type="checkbox"
                checked={safSync.value}
                onChange={(event) => safSync.onChange(event.target.checked)}
              />
              <span>{t('settings.sync.saf.use')}</span>
            </label>
          )}
          <p className="muted">{safSync?.value === true ? t('settings.sync.saf.using') : t('settings.sync.saf.notUsing')}</p>
          <p className="muted">
            {safSync?.value === true ? t('settings.sync.saf.noteOn') : t('settings.sync.saf.noteOff')}
          </p>
        </>
      )}

      {graceSync !== undefined && (
        <Field label={t('sync.gc.grace')} hint={t('sync.gc.grace.hint')}>
          <TextInput
            type="number"
            value={graceSync.value}
            placeholder="30"
            onBlur={() => undefined}
            onChange={(next) => graceSync.onChange(next)}
          />
        </Field>
      )}

      <h3 className="settings-group__title">{t('sync.devices')}</h3>
      <p className="muted">{t('sync.devices.hint')}</p>

      {devices === undefined ? (
        <p className="muted">{t('dev.volume.loading')}</p>
      ) : (
        <ul className="list">
          {devices.map((device) => (
            <ListRow
              key={device.deviceId}
              title={device.name}
              subtitle={device.deviceId}
              meta={[
                device.self ? t('sync.devices.self') : '',
                device.revoked ? t('sync.devices.revoked') : '',
                device.banned ? t('sync.devices.banned') : '',
              ]
                .filter((part) => part !== '')
                .join(' · ')}
              {...(device.self || device.revoked || device.banned ? {} : { onClick: () => setMenuFor(device.deviceId) })}
            />
          ))}
        </ul>
      )}

      <h3 className="settings-group__title">{t('sync.gc')}</h3>
      <p className="muted">{t('sync.gc.hint')}</p>
      <div className="row">
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(undefined);
            void sync
              .collect(true)
              .then((result) => {
                setAnalysis(result);
                setNote(
                  result.candidates.length === 0
                    ? t('sync.gc.none')
                    : t('sync.gc.candidates', { count: result.candidates.length }),
                );
              })
              .catch((cause: unknown) => setError(describeError(cause)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? t('sync.gc.running') : t('sync.gc.analyze')}
        </Button>
        {analysis !== undefined && analysis.candidates.length > 0 && (
          <Button variant="danger" onClick={() => setConfirmCollect(true)}>
            {t('sync.gc.collect', { count: analysis.candidates.length })}
          </Button>
        )}
      </div>

      {analysis !== undefined && analysis.reasons.length > 0 && (
        <details className="details">
          <summary>{t('sync.gc.reasons', { count: analysis.reasons.length })}</summary>
          <ul className="list">
            {analysis.reasons.slice(0, 12).map((reason, index) => (
              <li key={index} className="muted">
                {reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      <Sheet open={menu !== undefined} title={menu?.name} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="trash"
          label={t('sync.devices.revoke')}
          danger
          onClick={() => {
            const id = menu?.deviceId;
            setMenuFor(undefined);
            setConfirmRevoke(id);
          }}
        />
        <SheetItem
          icon="trash"
          label={t('sync.devices.ban')}
          danger
          onClick={() => {
            const id = menu?.deviceId;
            setMenuFor(undefined);
            setConfirmBan(id);
          }}
        />
      </Sheet>

      <ConfirmDialog
        open={revoking !== undefined}
        title={t('sync.devices.revoke.title')}
        message={t('sync.devices.revoke.message', { name: revoking?.name ?? '' })}
        confirmLabel={t('sync.devices.revoke')}
        onCancel={() => setConfirmRevoke(undefined)}
        onConfirm={() => {
          const id = confirmRevoke;
          setConfirmRevoke(undefined);
          if (id === undefined) return;
          void sync
            .revoke(id)
            .then((changed) => {
              setNote(changed ? t('sync.devices.revokedNote') : t('sync.devices.revokeFailed'));
              return reload();
            })
            .catch((cause: unknown) => setError(describeError(cause)));
        }}
      />

      <ConfirmDialog
        open={banning !== undefined}
        title={t('sync.devices.ban.title')}
        message={t('sync.devices.ban.message', { name: banning?.name ?? '' })}
        confirmLabel={t('sync.devices.ban')}
        onCancel={() => setConfirmBan(undefined)}
        onConfirm={() => {
          const id = confirmBan;
          setConfirmBan(undefined);
          if (id === undefined) return;
          void sync
            .ban(id)
            .then((changed) => {
              setNote(changed ? t('sync.devices.bannedNote') : t('sync.devices.banFailed'));
              return reload();
            })
            .catch((cause: unknown) => setError(describeError(cause)));
        }}
      />

      <ConfirmDialog
        open={confirmCollect}
        title={t('sync.gc.confirm.title')}
        message={t('sync.gc.confirm.message', { count: analysis?.candidates.length ?? 0 })}
        confirmLabel={t('sync.gc.confirm.ok')}
        onCancel={() => setConfirmCollect(false)}
        onConfirm={() => {
          setConfirmCollect(false);
          setBusy(true);
          void sync
            .collect(false)
            .then((result) => {
              setAnalysis(result);
              setNote(t('sync.gc.moved', { count: result.moved.length }));
            })
            .catch((cause: unknown) => setError(describeError(cause)))
            .finally(() => setBusy(false));
        }}
      />
    </>
  );
}
