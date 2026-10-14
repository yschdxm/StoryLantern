import { useEffect, useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { SETTING_KEYS } from '../data/types.ts';
import { HostPanel } from '../HostPanel.tsx';
import { Button, Field, TextInput } from '../ui/components.tsx';

export interface SettingsScreenProps extends ScreenProps {
  plugins: Array<{ id: string; status: string }>;
  locales: string[];
  onLocaleChange(locale: string): void;
}

const PROVIDERS = [
  { value: 'openai-compatible', label: 'OpenAI 兼容（DeepSeek / OpenAI / 本地模型）' },
  { value: 'offline', label: '不调用模型（只记录消息）' },
];

/**
 * 设置页。
 *
 * 只放**用户真的会改**的东西：模型服务、外观、数据、开发者。
 * 每一项都是"改完立即生效并存库"，没有"保存"按钮——移动端表单里多一个保存按钮就是多一次误操作。
 */
export function SettingsScreen({ store, host, chat, plugins, locales, onLocaleChange }: SettingsScreenProps): ReactNode {
  const state = useAppState(store);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [showKey, setShowKey] = useState(false);
  const [probeResult, setProbeResult] = useState<string | undefined>(undefined);
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

  const update = (key: string, next: string): void => {
    setLocal((current) => ({ ...current, [key]: next }));
  };

  const commit = (key: string): void => {
    const next = value(key);
    if (next === (state.settings[key] ?? '')) return;
    void store.actions.setSetting(key, next);
  };

  const provider = value(SETTING_KEYS.providerKind) === '' ? 'openai-compatible' : value(SETTING_KEYS.providerKind);
  const theme = value(SETTING_KEYS.theme) === '' ? 'dark' : value(SETTING_KEYS.theme);

  return (
    <div className="settings">
      <section className="settings-group">
        <h2 className="settings-group__title">模型服务</h2>
        <Field label="服务类型">
          <select
            className="input"
            value={provider}
            onChange={(event) => {
              update(SETTING_KEYS.providerKind, event.target.value);
              void store.actions.setSetting(SETTING_KEYS.providerKind, event.target.value);
            }}
          >
            {PROVIDERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="接口地址" hint="例如 https://api.deepseek.com/v1（本地地址可以不填密钥）">
          <TextInput
            type="url"
            value={value(SETTING_KEYS.baseUrl)}
            placeholder="https://api.deepseek.com/v1"
            onChange={(next) => update(SETTING_KEYS.baseUrl, next)}
            onBlur={() => commit(SETTING_KEYS.baseUrl)}
          />
        </Field>
        <Field label="API Key" hint="只存在宿主数据库里，不会写进前端日志；界面拿到的只是掩码">
          <TextInput
            type={showKey ? 'text' : 'password'}
            value={value(SETTING_KEYS.apiKey)}
            placeholder="sk-…"
            onChange={(next) => update(SETTING_KEYS.apiKey, next)}
            onBlur={() => commit(SETTING_KEYS.apiKey)}
          />
        </Field>
        <Field label="模型名" hint="例如 deepseek-chat / gpt-4o-mini">
          <TextInput
            value={value(SETTING_KEYS.model)}
            placeholder="deepseek-chat"
            onChange={(next) => update(SETTING_KEYS.model, next)}
            onBlur={() => commit(SETTING_KEYS.model)}
          />
        </Field>
        <div className="row">
          <Button variant="ghost" onClick={() => setShowKey((current) => !current)}>
            {showKey ? '隐藏密钥' : '显示密钥'}
          </Button>
          <Button
            variant="ghost"
            disabled={probing || !chat.available}
            onClick={() => {
              setProbing(true);
              setProbeResult(undefined);
              void chat
                .probe()
                .then((result) => setProbeResult(`${result.ok ? '✓' : '✗'} ${result.message}`))
                .finally(() => setProbing(false));
            }}
          >
            {probing ? '测试中…' : '测试连接'}
          </Button>
        </div>
        {probeResult !== undefined && <p className="notice">{probeResult}</p>}
        <p className="muted">
          改完离开输入框即自动保存。调用由宿主发出（Rust），密钥只存在宿主数据库里，日志里也不会出现明文。
        </p>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">外观</h2>
        <Field label="主题">
          <select
            className="input"
            value={theme}
            onChange={(event) => {
              update(SETTING_KEYS.theme, event.target.value);
              void store.actions.setSetting(SETTING_KEYS.theme, event.target.value);
              document.documentElement.dataset['theme'] = event.target.value;
            }}
          >
            <option value="dark">深色</option>
            <option value="light">浅色</option>
            <option value="system">跟随系统</option>
          </select>
        </Field>
        {locales.length > 0 && (
          <Field label="界面语言">
            <select className="input" value={state.settings[SETTING_KEYS.locale] ?? locales[0] ?? ''} onChange={(event) => onLocaleChange(event.target.value)}>
              {locales.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field>
        )}
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">数据</h2>
        <p className="muted">
          存储：{host.available ? '宿主 SQLite（应用私有目录）' : '浏览器 localStorage'}
        </p>
        <p className="muted">
          角色 {state.characters.length} · 会话 {state.sessions.length}
        </p>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">已激活的插件</h2>
        <ul className="chips">
          {plugins.map((plugin) => (
            <li key={plugin.id} className={`chip chip--${plugin.status}`}>
              {plugin.id}
              <small>{plugin.status}</small>
            </li>
          ))}
        </ul>
        <p className="muted">这些行来自组合文件（bundle patch）；关掉一行，对应功能就消失。</p>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">开发者</h2>
        <HostPanel client={host} />
      </section>

      <p className="muted settings__version">Story Lantern v0.1 · 手机优先 · 构建 {__BUILD_STAMP__}</p>
    </div>
  );
}
