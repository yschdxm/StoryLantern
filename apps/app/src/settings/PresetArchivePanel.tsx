import { useRef, useState, type ReactNode } from 'react';
import {
  MAX_PRESETS,
  PRESET_SETTING_KEY,
  listPresets,
  parsePresetFile,
  removePreset,
  savePreset,
  serializePresetFile,
} from '../data/prompt-presets.ts';
import { describeError } from '../data/error-text.ts';
import { useT } from '../i18n/context.tsx';
import { useAppState } from '../screens/screen-props.ts';
import type { AppStore } from '../app/state.ts';
import { Button } from '../ui/components.tsx';

function fileNameOf(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return `${safe === '' ? 'preset' : safe}.json`;
}

/**
 * 酒馆预设存档（B1/B29 兼容层）：**导入后只存档、可原样导出**。
 * 这里不碰运行时装配；设置键由 `prompt-presets.ts` 定义（上限 50）。
 */
export function PresetArchivePanel({ store }: { store: AppStore }): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | undefined>(undefined);

  const { presets, skipped } = listPresets(state.settings);

  const importFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setBusy(true);
    setFeedback(undefined);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      const parsed = parsePresetFile(text);
      if (!parsed.ok) {
        setFeedback({
          ok: false,
          text: t('presets.error.line', { code: parsed.code, message: t(`presets.error.${parsed.code}`) }),
        });
        return;
      }
      const saved = savePreset(store.getState().settings, parsed.preset);
      if (!saved.saved) {
        setFeedback({ ok: false, text: t('presets.error.full') });
        return;
      }
      await store.actions.setSetting(PRESET_SETTING_KEY, saved.settings[PRESET_SETTING_KEY] ?? '');
      setFeedback({ ok: true, text: t('presets.imported', { name: parsed.preset.name }) });
    } catch (cause) {
      setFeedback({ ok: false, text: t('presets.error.save', { message: describeError(cause) }) });
    } finally {
      setBusy(false);
    }
  };

  const download = (id: string): void => {
    const preset = presets.find((item) => item.id === id);
    if (preset === undefined) return;
    if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      setFeedback({ ok: false, text: t('presets.export.unavailable') });
      return;
    }
    try {
      const blob = new Blob([serializePresetFile(preset)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileNameOf(preset.name);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setFeedback({ ok: true, text: t('presets.exported', { name: preset.name }) });
    } catch (cause) {
      setFeedback({ ok: false, text: t('presets.export.failed', { message: describeError(cause) }) });
    }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    setFeedback(undefined);
    try {
      const next = removePreset(store.getState().settings, id);
      await store.actions.setSetting(PRESET_SETTING_KEY, next[PRESET_SETTING_KEY] ?? '');
      setFeedback({ ok: true, text: t('presets.removed') });
    } catch (cause) {
      setFeedback({ ok: false, text: t('presets.removeFailed', { message: describeError(cause) }) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="preset-archive">
      <p className="notice">{t('presets.note')}</p>
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept=".json,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          void importFile(file);
          event.currentTarget.value = '';
        }}
      />
      <div className="row">
        <Button disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? t('presets.importing') : t('presets.import')}
        </Button>
        <span className="trace__meta">{t('presets.capacity', { count: presets.length, max: MAX_PRESETS })}</span>
      </div>
      {feedback !== undefined && (
        <p className={feedback.ok ? 'notice notice--ok' : 'notice notice--warn'}>{feedback.text}</p>
      )}
      {skipped > 0 && <p className="notice notice--warn">{t('presets.skipped', { count: skipped })}</p>}

      {presets.length === 0 ? (
        <p className="muted">{t('presets.empty')}</p>
      ) : (
        <ul className="trace__list">
          {presets.map((preset) => (
            <li key={preset.id}>
              <span className="trace__name">{preset.name}</span>
              <span className="trace__meta">
                {t(`presets.kind.${preset.kind}`)}
                {' · '}
                {preset.importedAt === 0 ? '—' : new Date(preset.importedAt).toLocaleString()}
              </span>
              <div className="row">
                <Button variant="ghost" onClick={() => download(preset.id)}>
                  {t('presets.export')}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void remove(preset.id)}>
                  {t('presets.remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
