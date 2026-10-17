import { useState, type ReactNode } from 'react';
import type { AppStore } from '../app/state.ts';
import { createWebPlatformPort } from '../data/platform-port.ts';
import { exportProfile, mergeProfileSettings, parseProfile, ProfileError } from '../data/profile-file.ts';
import { useT } from '../i18n/context.tsx';
import { Banner, Button } from '../ui/components.tsx';

/**
 * 「配置文件（可分享）」：导出/导入**不含密钥**的设置快照。
 *
 * 为什么单独一个面板：`SettingsScreen.tsx` 已经 399 行（门禁 400），再塞会把文件顶爆；
 * 这个功能本身也够独立（纯 JSON 进出）。
 *
 * 密钥纪律是这条功能的核心：导出走 `exportProfile`（按模式剔除密钥类键），
 * 导入走 `parseProfile`（同样拒绝密钥类字段），两边都会把"剔除了几个键"报给用户。
 * 剪贴板通过 `PlatformPort`（而不是直接摸 `navigator.clipboard`），没有剪贴板的环境会明确报错。
 */
export function ProfilesPanel({ store }: { store: AppStore }): ReactNode {
  const t = useT();
  const [exported, setExported] = useState('');
  const [incoming, setIncoming] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  const platform = createWebPlatformPort();

  const generate = (): void => {
    const result = exportProfile({ settings: store.getState().settings });
    setExported(JSON.stringify(result.profile, null, 2));
    setNote(
      result.removedKeys.length === 0
        ? undefined
        : t('settings.profile.removed', { count: result.removedKeys.length }),
    );
  };

  const copy = (): void => {
    void platform.clipboard
      .write(exported)
      .then(() => setNote(t('settings.profile.copied')))
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : String(error)));
  };

  const apply = async (): Promise<void> => {
    try {
      const parsed = parseProfile(JSON.parse(incoming) as unknown);
      const merged = mergeProfileSettings(store.getState().settings, parsed.profile);
      for (const key of merged.changed) await store.actions.setSetting(key, merged.settings[key] ?? '');
      setNote(
        t('settings.profile.applied', { count: merged.changed.length }) +
          (parsed.removedKeys.length === 0 ? '' : t('settings.profile.removed', { count: parsed.removedKeys.length })),
      );
    } catch (error) {
      setNote(
        error instanceof ProfileError
          ? error.message
          : error instanceof SyntaxError
            ? `${t('settings.profile.apply')}: JSON 解析失败`
            : error instanceof Error
              ? error.message
              : String(error),
      );
    }
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('settings.profile.title')}</h2>
      <p className="muted">{t('settings.profile.hint')}</p>
      <div className="row">
        <Button variant="ghost" onClick={generate}>
          {t('settings.profile.generate')}
        </Button>
        <Button variant="ghost" disabled={exported === ''} onClick={copy}>
          {t('settings.profile.copy')}
        </Button>
      </div>
      {exported !== '' && (
        <textarea className="settings__profile-text" readOnly rows={8} value={exported} aria-label={t('settings.profile.title')} />
      )}
      <textarea
        className="settings__profile-text"
        rows={6}
        placeholder={t('settings.profile.paste')}
        value={incoming}
        onChange={(event) => setIncoming(event.target.value)}
        aria-label={t('settings.profile.paste')}
      />
      <div className="row">
        <Button disabled={incoming.trim() === ''} onClick={() => void apply()}>
          {t('settings.profile.apply')}
        </Button>
      </div>
      {note !== undefined && <Banner tone="info">{note}</Banner>}
    </section>
  );
}
