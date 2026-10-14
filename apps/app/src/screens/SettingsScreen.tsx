import { useEffect, useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import { SETTING_KEYS } from '../data/types.ts';
import { HostPanel } from '../HostPanel.tsx';
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
export function SettingsScreen({ store, router, host, chat, plugins, locales, onLocaleChange }: SettingsScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [probing, setProbing] = useState(false);

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
        <HostPanel client={host} />
      </section>

      <p className="muted settings__version">{t('settings.version', { stamp: __BUILD_STAMP__ })}</p>
    </div>
  );
}
