import { useState, type ReactNode } from 'react';
import { readProfiles } from '../data/model-routing.ts';
import { SETTING_KEYS } from '../data/types.ts';
import { useT } from '../i18n/context.tsx';
import { useAppState } from '../screens/screen-props.ts';
import { ModelProfilesPanel } from '../screens/ModelProfilesPanel.tsx';
import { Button, Field, TextArea, TextInput } from '../ui/components.tsx';
import { SettingsRow } from '../ui/SettingsRow.tsx';
import { SettingsDetail, SettingsList, useSectionDetail } from './SettingsSection.tsx';
import type { SettingsProps } from './settings-types.ts';
import { useSettingsDraft } from './use-settings-draft.ts';

/**
 * 模型与密钥（L2）。
 *
 * L2 只放两行：聊天模型（单模型快速配置）与多模型路由（ModelProfilesPanel，
 * 面板里已经包含向量来源与用量/成本）。两行都进 L3，密钥输入只写不读的规矩不变。
 */
export function ModelSettings({ store, chat, transport, initialRow }: SettingsProps & { initialRow?: string | undefined }): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const { value, update, commit, saveNow } = useSettingsDraft(store, state.settings);
  const { detail, open, close } = useSectionDetail(initialRow);
  const [showKey, setShowKey] = useState(false);
  const [probeResult, setProbeResult] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [probing, setProbing] = useState(false);

  const provider = value(SETTING_KEYS.providerKind) === '' ? 'openai-compatible' : value(SETTING_KEYS.providerKind);
  const model = state.settings[SETTING_KEYS.model] ?? '';
  const keySet = (state.settings[SETTING_KEYS.apiKey] ?? '') !== '';
  const chatValue =
    model === ''
      ? t('settings.home.unset')
      : t('settings.home.modelValue', {
          model,
          key: keySet ? t('settings.home.keySet') : t('settings.home.keyUnset'),
        });
  const profilesValue = t('settings.home.profiles', { count: readProfiles(state.settings).length });

  if (detail !== undefined) {
    return (
      <SettingsDetail section="model" titleKey={detail === 'profiles' ? 'settings.row.modelProfiles' : 'settings.row.chatModel'} onBack={close}>
        {detail === 'profiles' ? (
          <ModelProfilesPanel
            store={store}
            chat={chat}
            settings={state.settings}
            {...(transport === undefined ? {} : { transport })}
          />
        ) : (
          <>
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
                placeholder={t('settings.model.baseUrl.placeholder')}
                onChange={(next) => update(SETTING_KEYS.baseUrl, next)}
                onBlur={() => commit(SETTING_KEYS.baseUrl)}
              />
            </Field>
            <Field label={t('settings.model.apiKey')} hint={t('settings.model.apiKey.hint')}>
              <TextInput
                type={showKey ? 'text' : 'password'}
                value={value(SETTING_KEYS.apiKey)}
                placeholder={t('settings.model.apiKey.placeholder')}
                onChange={(next) => update(SETTING_KEYS.apiKey, next)}
                onBlur={() => commit(SETTING_KEYS.apiKey)}
              />
            </Field>
            <Field label={t('settings.model.name')} hint={t('settings.model.name.hint')}>
              <TextInput
                value={value(SETTING_KEYS.model)}
                placeholder={t('settings.model.name.placeholder')}
                onChange={(next) => update(SETTING_KEYS.model, next)}
                onBlur={() => commit(SETTING_KEYS.model)}
              />
            </Field>
            <label className="switch">
              <input
                type="checkbox"
                checked={value(SETTING_KEYS.cite) === 'on'}
                onChange={(event) => saveNow(SETTING_KEYS.cite, event.target.checked ? 'on' : 'off')}
              />
              <span>{t('settings.model.cite')}</span>
            </label>
            <p className="field__hint">{t('settings.model.cite.hint')}</p>
            <label className="switch">
              <input
                type="checkbox"
                checked={value(SETTING_KEYS.streamUsage) !== 'off'}
                onChange={(event) => saveNow(SETTING_KEYS.streamUsage, event.target.checked ? 'on' : 'off')}
              />
              <span>{t('settings.model.streamUsage')}</span>
            </label>
            <p className="field__hint">{t('settings.model.streamUsage.hint')}</p>
            <Field label={t('settings.model.loreScanDepth')} hint={t('settings.model.loreScanDepth.hint')}>
              <TextInput
                type="number"
                value={value(SETTING_KEYS.loreScanDepth) === '' ? '4' : value(SETTING_KEYS.loreScanDepth)}
                onChange={(next) => update(SETTING_KEYS.loreScanDepth, next)}
                onBlur={() => {
                  const raw = value(SETTING_KEYS.loreScanDepth);
                  const parsed = Number(raw);
                  const clamped = raw.trim() === '' || !Number.isFinite(parsed) ? 4 : Math.min(20, Math.max(1, Math.round(parsed)));
                  if (raw.trim() === '' || String(clamped) !== raw) saveNow(SETTING_KEYS.loreScanDepth, String(clamped));
                  else commit(SETTING_KEYS.loreScanDepth);
                }}
              />
            </Field>
            <Field label={t('settings.model.authorsNote')} hint={t('settings.model.authorsNote.hint')}>
              <TextArea
                value={value(SETTING_KEYS.authorsNote)}
                onChange={(next) => update(SETTING_KEYS.authorsNote, next)}
                onBlur={() => commit(SETTING_KEYS.authorsNote)}
                rows={4}
                placeholder={t('settings.model.authorsNote.placeholder')}
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
          </>
        )}
      </SettingsDetail>
    );
  }

  return (
    <SettingsList testId="settings-section-model-page">
      <SettingsRow label={t('settings.row.chatModel')} value={chatValue} onPress={() => open('chat')} />
      <SettingsRow label={t('settings.row.modelProfiles')} value={profilesValue} onPress={() => open('profiles')} />
    </SettingsList>
  );
}
