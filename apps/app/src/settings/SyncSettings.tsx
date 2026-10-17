import { useEffect, useState, type ReactNode } from 'react';
import { describeError } from '../data/error-text.ts';
import { formatTime } from '../data/repository.ts';
import { SETTING_KEYS } from '../data/types.ts';
import { useT } from '../i18n/context.tsx';
import { useAppState } from '../screens/screen-props.ts';
import { PairingPanel } from '../screens/PairingPanel.tsx';
import { S3Fields, S3_SETTING_KEYS } from '../screens/S3Fields.tsx';
import { SyncDevices } from '../screens/SyncDevices.tsx';
import { WebDavFields } from '../screens/WebDavFields.tsx';
import { Button, Field, TextInput } from '../ui/components.tsx';
import { SettingsRow } from '../ui/SettingsRow.tsx';
import { SettingsDetail, SettingsList, useSectionDetail } from './SettingsSection.tsx';
import type { SettingsProps } from './settings-types.ts';
import { useSettingsDraft } from './use-settings-draft.ts';

/**
 * 同步与设备（L2）。
 *
 * 行内只留"同步方式"和"立即同步"（改完即生效/动作）；连接字段、口令、设备名单、配对
 * 全部进 L3。口令沿用只写不读：界面只显示"已设置/未设置"，输入框留空表示不改。
 */
export function SyncSettings({ store, sync, initialRow }: SettingsProps & { initialRow?: string | undefined }): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const { value, update, commit, saveNow } = useSettingsDraft(store, state.settings);
  const { detail, open, close } = useSectionDetail(initialRow);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [secretDraft, setSecretDraft] = useState('');
  const [s3SecretDraft, setS3SecretDraft] = useState('');
  const [folderRoot, setFolderRoot] = useState('');

  const syncKind = value(SETTING_KEYS.syncKind) || 'off';
  const hasSecret = sync?.hasSecret === true;

  useEffect(() => {
    if (syncKind !== 'folder' || sync === undefined || sync.folderAvailable === false) return;
    let alive = true;
    void sync
      .folderRoot()
      .then((path) => {
        if (alive) setFolderRoot(path);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [syncKind, sync]);

  const connectionReady =
    syncKind === 'webdav'
      ? value(SETTING_KEYS.syncUrl) !== ''
      : syncKind === 's3'
        ? value(SETTING_KEYS.syncS3Endpoint) !== '' && value(SETTING_KEYS.syncS3Bucket) !== '' && value(SETTING_KEYS.syncS3AccessKeyId) !== ''
        : syncKind === 'folder';

  const lastAt = state.settings[SETTING_KEYS.syncLastAt];
  const lastSync = lastAt === undefined ? t('settings.sync.never') : t('settings.sync.lastAt', { time: formatTime(Number(lastAt)) });

  const runSync = (): void => {
    if (sync === undefined) return;
    setSyncing(true);
    setSyncResult(undefined);
    void (async () => {
      // 先把还在输入框里的非机密值落库（await），再同步：否则"填完地址立刻点同步"会读到旧设置
      for (const key of [SETTING_KEYS.syncUrl, SETTING_KEYS.syncUsername, SETTING_KEYS.syncPassword, SETTING_KEYS.syncFolder, ...S3_SETTING_KEYS]) {
        await store.actions.setSetting(key, value(key));
      }
      const draft = secretDraft.trim();
      const s3Draft = s3SecretDraft.trim();
      return sync.run(draft === '' ? undefined : draft, s3Draft === '' ? undefined : s3Draft);
    })()
      .then((summary) => {
        setSecretDraft('');
        if (summary.root !== undefined) setFolderRoot(summary.root);
        const notes = summary.warnings.filter((item) => item !== '');
        const done = t('settings.sync.done', {
          uploaded: summary.uploaded,
          downloaded: summary.downloaded,
          applied: summary.appliedOps,
        });
        setSyncResult({ ok: notes.length === 0, text: notes.length === 0 ? done : `${done}｜${notes.join(' ')}` });
      })
      .catch((cause: unknown) => setSyncResult({ ok: false, text: t('settings.sync.failed', { message: describeError(cause) }) }))
      .finally(() => setSyncing(false));
  };

  if (detail !== undefined) {
    const titleKey =
      detail === 'connection'
        ? 'settings.row.connection'
        : detail === 'secret'
          ? 'settings.sync.secret'
          : detail === 'devices'
            ? 'settings.row.devices'
            : 'settings.row.pairing';
    return (
      <SettingsDetail section="sync" titleKey={titleKey} onBack={close}>
        {detail === 'connection' && (
          <section className="settings-group">
            {syncKind === 'webdav' && <WebDavFields value={value} update={update} commit={commit} />}
            {syncKind === 's3' && (
              <S3Fields value={value} update={update} commit={commit} secretDraft={s3SecretDraft} onSecretDraft={setS3SecretDraft} />
            )}
            {syncKind === 'folder' && (
              <>
                <Field
                  label={t('settings.sync.folder.path')}
                  hint={value(SETTING_KEYS.syncFolderSaf) === 'on' ? t('settings.sync.folder.safActive') : t('settings.sync.folder.hint')}
                >
                  <TextInput
                    value={value(SETTING_KEYS.syncFolder)}
                    disabled={value(SETTING_KEYS.syncFolderSaf) === 'on'}
                    placeholder={folderRoot === '' ? t('settings.sync.folder.default') : folderRoot}
                    onChange={(next) => update(SETTING_KEYS.syncFolder, next)}
                    onBlur={() => {
                      commit(SETTING_KEYS.syncFolder);
                      void sync?.folderRoot().then(setFolderRoot).catch(() => undefined);
                    }}
                  />
                </Field>
                {folderRoot !== '' && <p className="muted">{t('settings.sync.folder.root', { path: folderRoot })}</p>}
              </>
            )}
          </section>
        )}
        {detail === 'secret' && (
          <section className="settings-group">
            <Field label={t('settings.sync.secret')} hint={t('settings.sync.secret.hint')}>
              {/* 口令只写：界面既不回显明文也不回显掩码（掩码写回去会覆盖真口令） */}
              <TextInput
                type="password"
                value={secretDraft}
                placeholder={hasSecret ? t('settings.sync.secret.saved') : t('settings.sync.secret.placeholder')}
                onChange={setSecretDraft}
              />
            </Field>
            <p className="muted">{t('settings.sync.note')}</p>
          </section>
        )}
        {detail === 'devices' && sync !== undefined && (
          <SyncDevices
            sync={sync}
            safPick={sync.safPick}
            graceSync={{ value: value(SETTING_KEYS.syncGcGraceDays), onChange: (next) => saveNow(SETTING_KEYS.syncGcGraceDays, next) }}
            safSync={{
              value: value(SETTING_KEYS.syncFolderSaf) === 'on',
              onChange: (next) => saveNow(SETTING_KEYS.syncFolderSaf, next ? 'on' : 'off'),
            }}
          />
        )}
        {detail === 'pairing' && sync !== undefined && (
          <PairingPanel createJoinLink={() => sync.createJoinLink()} applyJoinLink={(link) => sync.applyJoinLink(link)} />
        )}
      </SettingsDetail>
    );
  }

  return (
    <>
      <SettingsList testId="settings-section-sync-page">
        <SettingsRow
          label={t('settings.sync.kind')}
          control={
            <select className="input settings-row__select" value={syncKind} onChange={(event) => saveNow(SETTING_KEYS.syncKind, event.target.value)} aria-label={t('settings.sync.kind')}>
              <option value="off">{t('settings.sync.off')}</option>
              <option value="webdav">{t('settings.sync.webdav')}</option>
              <option value="folder">{t('settings.sync.folder')}</option>
              <option value="s3">{t('settings.sync.s3')}</option>
            </select>
          }
        />
        {syncKind !== 'off' && (
          <>
            <SettingsRow
              label={t('settings.row.connection')}
              value={connectionReady ? t('settings.value.configured') : t('settings.value.connectionNeeded')}
              onPress={() => open('connection')}
            />
            <SettingsRow
              label={t('settings.sync.secret')}
              value={hasSecret ? t('settings.value.secretSet') : t('settings.value.secretUnset')}
              onPress={() => open('secret')}
            />
            {sync !== undefined && (
              <SettingsRow label={t('settings.row.devices')} value={t('settings.value.manage')} onPress={() => open('devices')} />
            )}
            {sync !== undefined && (
              <SettingsRow label={t('settings.row.pairing')} value={t('settings.value.pairing')} onPress={() => open('pairing')} />
            )}
            <SettingsRow
              label={t('settings.row.run')}
              value={lastSync}
              control={
                <Button
                  disabled={
                    sync === undefined ||
                    syncing ||
                    sync.available === false ||
                    (syncKind === 'webdav' ? sync.backendAvailable === false : syncKind === 'folder' ? sync.folderAvailable === false : false)
                  }
                  onClick={runSync}
                >
                  {syncing ? t('settings.sync.running') : t('settings.sync.run')}
                </Button>
              }
            />
          </>
        )}
      </SettingsList>
      {syncKind !== 'off' && syncResult !== undefined && (
        <p className={`notice notice--${syncResult.ok ? 'ok' : 'warn'}`}>{syncResult.text}</p>
      )}
      {syncKind !== 'off' && sync !== undefined && !sync.available && <p className="notice notice--warn">{t('settings.sync.noCrypto')}</p>}
      {sync !== undefined && syncKind === 'webdav' && !sync.backendAvailable && <p className="notice notice--warn">{t('settings.sync.noBackend')}</p>}
      {sync !== undefined && syncKind === 'folder' && !sync.folderAvailable && <p className="notice notice--warn">{t('settings.sync.noFolder')}</p>}
    </>
  );
}
