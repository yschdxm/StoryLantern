import { useEffect, useState, type ReactNode } from 'react';
import { describeError } from '../data/error-text.ts';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import { SETTING_KEYS } from '../data/types.ts';
import { formatTime } from '../data/repository.ts';
import { HostPanel } from '../HostPanel.tsx';
import { ModelProfilesPanel } from './ModelProfilesPanel.tsx';
import { SyncDevices } from './SyncDevices.tsx';
import { S3Fields, S3_SETTING_KEYS } from './S3Fields.tsx';
import { WebDavFields } from './WebDavFields.tsx';
import { PairingPanel } from './PairingPanel.tsx';
import { Button, Field, TextInput } from '../ui/components.tsx';
export interface SettingsScreenProps extends ScreenProps {
  plugins: Array<{ id: string; status: string }>;
  locales: string[];
  onLocaleChange(locale: string): void;
}

/** 分段选择器：主题/字号这种"少量互斥选项"用它比下拉框少一次点击，也看得见当前值。 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}): ReactNode {
  return (
    <div className="segmented" role="group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`segmented__item${option.value === value ? ' segmented__item--active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 设置页。
 *
 * 只放**用户真的会改**的东西：模型服务、外观、数据、开发者。
 * 文本类改完即存（失焦自动保存），选择类点一下就生效——没有"保存"按钮，
 * 移动端表单里多一个保存按钮就是多一次误操作。
 */
export function SettingsScreen({ store, router, host, chat, ops, sync, plugins, locales, onLocaleChange, transport }: SettingsScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [probing, setProbing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [secretDraft, setSecretDraft] = useState('');
  /** S3 的 Secret Key：与同步口令一样只写、只存设备本地（不进设置，避免被掩码覆盖）。 */
  const [s3SecretDraft, setS3SecretDraft] = useState('');
  /** 宿主解析出来的同步文件夹根目录（"文件到底放哪了"要看得见）。 */
  const [folderRoot, setFolderRoot] = useState('');
  const syncKind = state.settings[SETTING_KEYS.syncKind] ?? 'off';

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

  const value = (key: string): string => local[key] ?? state.settings[key] ?? '';

  // 从 store 同步一次（首次加载完成后）
  useEffect(() => {
    setLocal((current) => {
      const next = { ...current };
      for (const key of Object.values(SETTING_KEYS)) {
        if (next[key] === undefined && state.settings[key] !== undefined) next[key] = state.settings[key] as string;
      }
      return next;
    });
  }, [state.settings]);

  const update = (key: string, next: string): void => setLocal((current) => ({ ...current, [key]: next }));

  const commit = (key: string): void => {
    const next = value(key);
    if (next === (state.settings[key] ?? '')) return;
    void store.actions.setSetting(key, next);
  };

  const saveNow = (key: string, next: string): void => {
    update(key, next);
    void store.actions.setSetting(key, next);
  };

  const provider = value(SETTING_KEYS.providerKind) === '' ? 'openai-compatible' : value(SETTING_KEYS.providerKind);
  const theme = value(SETTING_KEYS.theme) === '' ? 'dark' : value(SETTING_KEYS.theme);
  const fontScale = value(SETTING_KEYS.fontScale) === '' ? 'normal' : value(SETTING_KEYS.fontScale);
  const locale = state.settings[SETTING_KEYS.locale] ?? locales[0] ?? '';

  return (
    <div className="settings">
      <section className="settings-group">
        <h2 className="settings-group__title">{t('settings.model')}</h2>
        <Field label={t('settings.model.provider')}>
          <select className="input" value={provider} onChange={(event) => saveNow(SETTING_KEYS.providerKind, event.target.value)}>
            <option value="openai-compatible">{t('settings.model.provider.openai')}</option>
            <option value="offline">{t('settings.model.provider.offline')}</option>
          </select>
        </Field>
        <Field label={t('settings.model.baseUrl')} hint={t('settings.model.baseUrl.hint')}>
          <TextInput
            type="url"
            value={value(SETTING_KEYS.baseUrl)}
            placeholder="https://api.deepseek.com/v1"
            onChange={(next) => update(SETTING_KEYS.baseUrl, next)}
            onBlur={() => commit(SETTING_KEYS.baseUrl)}
          />
        </Field>
        <Field label={t('settings.model.apiKey')} hint={t('settings.model.apiKey.hint')}>
          <TextInput
            type={showKey ? 'text' : 'password'}
            value={value(SETTING_KEYS.apiKey)}
            placeholder="sk-…"
            onChange={(next) => update(SETTING_KEYS.apiKey, next)}
            onBlur={() => commit(SETTING_KEYS.apiKey)}
          />
        </Field>
        <Field label={t('settings.model.name')} hint={t('settings.model.name.hint')}>
          <TextInput
            value={value(SETTING_KEYS.model)}
            placeholder="deepseek-chat"
            onChange={(next) => update(SETTING_KEYS.model, next)}
            onBlur={() => commit(SETTING_KEYS.model)}
          />
        </Field>
        <div className="row">
          <Button variant="ghost" onClick={() => setShowKey((current) => !current)}>
            {showKey ? t('settings.model.hideKey') : t('settings.model.showKey')}
          </Button>
          <Button
            variant="ghost"
            disabled={probing || !chat.available}
            onClick={() => {
              setProbing(true);
              setProbeResult(undefined);
              void chat
                .probe()
                .then((result) =>
                  setProbeResult(
                    result.ok
                      ? { ok: true, text: t('settings.model.probeOk') }
                      : { ok: false, text: t('settings.model.probeFail', { message: result.message }) },
                  ),
                )
                .finally(() => setProbing(false));
            }}
          >
            {probing ? t('settings.model.testing') : t('settings.model.test')}
          </Button>
        </div>
        {probeResult !== undefined && <p className={`notice notice--${probeResult.ok ? 'ok' : 'warn'}`}>{probeResult.text}</p>}
        <p className="muted">{t('settings.model.note')}</p>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">{t('settings.appearance')}</h2>
        <Field label={t('settings.theme')}>
          <Segmented
            value={theme}
            onChange={(next) => saveNow(SETTING_KEYS.theme, next)}
            options={[
              { value: 'dark', label: t('settings.theme.dark') },
              { value: 'light', label: t('settings.theme.light') },
              { value: 'system', label: t('settings.theme.system') },
            ]}
          />
        </Field>
        <Field label={t('settings.fontScale')}>
          <Segmented
            value={fontScale}
            onChange={(next) => saveNow(SETTING_KEYS.fontScale, next)}
            options={[
              { value: 'small', label: t('settings.fontScale.small') },
              { value: 'normal', label: t('settings.fontScale.normal') },
              { value: 'large', label: t('settings.fontScale.large') },
            ]}
          />
        </Field>
        {locales.length > 0 && (
          <Field label={t('settings.language')}>
            <select className="input" value={locale} onChange={(event) => onLocaleChange(event.target.value)}>
              {locales.map((item) => (
                <option key={item} value={item}>
                  {item === 'zh-CN' ? '简体中文' : item === 'en' ? 'English' : item}
                </option>
              ))}
            </select>
          </Field>
        )}
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">{t('settings.models')}</h2>
        <ModelProfilesPanel store={store} chat={chat} settings={state.settings} {...(transport === undefined ? {} : { transport })} />
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">{t('settings.sync')}</h2>
        <Field label={t('settings.sync.kind')}>
          <select className="input" value={value(SETTING_KEYS.syncKind) || 'off'} onChange={(event) => saveNow(SETTING_KEYS.syncKind, event.target.value)}>
            <option value="off">{t('settings.sync.off')}</option>
            <option value="webdav">{t('settings.sync.webdav')}</option>
            <option value="folder">{t('settings.sync.folder')}</option>
            <option value="s3">{t('settings.sync.s3')}</option>
          </select>
        </Field>
        {(value(SETTING_KEYS.syncKind) || 'off') === 'webdav' && (
          <WebDavFields value={value} update={update} commit={commit} />
        )}
        {(value(SETTING_KEYS.syncKind) || 'off') === 's3' && (
          <S3Fields
            value={value}
            update={update}
            commit={commit}
            secretDraft={s3SecretDraft}
            onSecretDraft={setS3SecretDraft}
          />
        )}
        {(value(SETTING_KEYS.syncKind) || 'off') === 'folder' && (
          <>
            <Field label={t('settings.sync.folder.path')} hint={value(SETTING_KEYS.syncFolderSaf) === 'on' ? t('settings.sync.folder.safActive') : t('settings.sync.folder.hint')}>
              <TextInput
                value={value(SETTING_KEYS.syncFolder)}
                disabled={value(SETTING_KEYS.syncFolderSaf) === 'on'}
                placeholder={folderRoot === '' ? t('settings.sync.folder.default') : folderRoot}
                onChange={(next) => update(SETTING_KEYS.syncFolder, next)}
                onBlur={() => {
                  commit(SETTING_KEYS.syncFolder);
                  // 改完立刻把宿主的根目录换过去，界面就能显示最终落点
                  void sync?.folderRoot().then(setFolderRoot).catch(() => undefined);
                }}
              />
            </Field>
            {folderRoot !== '' && <p className="muted">{t('settings.sync.folder.root', { path: folderRoot })}</p>}
          </>
        )}
        {(value(SETTING_KEYS.syncKind) || 'off') !== 'off' && (
          <>
            <Field label={t('settings.sync.secret')} hint={t('settings.sync.secret.hint')}>
              {/* 口令**只写**：界面既不回显明文也不回显掩码（掩码写回去会覆盖真口令） */}
              <TextInput
                type="password"
                value={secretDraft}
                placeholder={sync?.hasSecret === true ? t('settings.sync.secret.saved') : t('settings.sync.secret.placeholder')}
                onChange={setSecretDraft}
              />
            </Field>
            <p className="muted">{t('settings.sync.note')}</p>
            {/* 设备名单 / 吊销 / 永久禁用 / 回收 / 恢复密钥：**只要配了同步就该出现**。
                以前它被放在"本地文件夹"分支里，于是用 WebDAV 的人根本看不到设备管理（真机踩到）。 */}
            {sync !== undefined && (
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
            {sync !== undefined && (
              <PairingPanel
                createJoinLink={() => sync.createJoinLink()}
                applyJoinLink={(link) => sync.applyJoinLink(link)}
              />
            )}
            <div className="row">
              <Button
                disabled={
                  sync === undefined ||
                  syncing ||
                  sync.available === false ||
                  ((value(SETTING_KEYS.syncKind) || 'off') === 'webdav' ? sync.backendAvailable === false : sync.folderAvailable === false)
                }
                onClick={() => {
                  if (sync === undefined) return;
                  setSyncing(true);
                  setSyncResult(undefined);
                  void (async () => {
                    // 先把还在输入框里的非机密值**落库**（await），再同步：
                    // 否则"填完地址立刻点同步"会读到旧设置——真机上踩过。
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
                      // 警告必须显示出来：例如"这台设备的 WebView 不支持 X25519，无法加入共享目录"，
                      // 以前只显示「完成：上传 1 段」，用户会以为已经加入了（真机上踩到）。
                      const notes = summary.warnings.filter((item) => item !== "");
                      const done = t('settings.sync.done', {
                        uploaded: summary.uploaded,
                        downloaded: summary.downloaded,
                        applied: summary.appliedOps,
                      });
                      setSyncResult({
                        ok: notes.length === 0,
                        text: notes.length === 0 ? done : `${done}｜${notes.join(" ")}`,
                      });
                    })
                    .catch((cause: unknown) =>
                      setSyncResult({
                        ok: false,
                        text: t('settings.sync.failed', { message: describeError(cause) }),
                      }),
                    )
                    .finally(() => setSyncing(false));
                }}
              >
                {syncing ? t('settings.sync.running') : t('settings.sync.run')}
              </Button>
              <span className="muted">
                {state.settings[SETTING_KEYS.syncLastAt] === undefined
                  ? t('settings.sync.never')
                  : t('settings.sync.lastAt', { time: formatTime(Number(state.settings[SETTING_KEYS.syncLastAt])) })}
              </span>
            </div>
            {sync !== undefined && !sync.available && <p className="notice notice--warn">{t('settings.sync.noCrypto')}</p>}
            {sync !== undefined && syncKind === 'webdav' && !sync.backendAvailable && (
              <p className="notice notice--warn">{t('settings.sync.noBackend')}</p>
            )}
            {sync !== undefined && syncKind === 'folder' && !sync.folderAvailable && (
              <p className="notice notice--warn">{t('settings.sync.noFolder')}</p>
            )}
            {syncResult !== undefined && <p className={`notice notice--${syncResult.ok ? 'ok' : 'warn'}`}>{syncResult.text}</p>}
          </>
        )}
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">{t('settings.data')}</h2>
        <p className="muted">{host.available ? t('settings.data.store.host') : t('settings.data.store.browser')}</p>
        <p className="muted">
          {t('settings.data.counts', {
            characters: t('count.characters', { count: state.characters.length }),
            sessions: t('count.sessions', { count: state.sessions.length }),
          })}
        </p>
        <Button variant="ghost" onClick={() => router.navigate({ name: 'import' })}>
          {t('import.title')}
        </Button>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">{t('settings.plugins')}</h2>
        <ul className="chips">
          {plugins.map((plugin) => (
            <li key={plugin.id} className={`chip chip--${plugin.status}`}>
              {plugin.id}
              <small>{plugin.status}</small>
            </li>
          ))}
        </ul>
        <p className="muted">{t('settings.plugins.note')}</p>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">{t('settings.developer')}</h2>
        <HostPanel client={host} ops={ops} />
      </section>

      <p className="muted settings__version">{t('settings.version', { stamp: __BUILD_STAMP__ })}</p>
    </div>
  );
}
