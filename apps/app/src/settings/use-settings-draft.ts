import { useEffect, useState } from 'react';
import type { AppStore } from '../app/state.ts';
import { SETTING_KEYS, type SettingsMap } from '../data/types.ts';

/**
 * 设置页的"本地草稿 + 失焦落库"。
 *
 * 文本类设置如果每次按键都 setSetting，下一次按键会先被"设置里还没更新的旧值"覆盖回来
 * （真机上表现为地址只留下最后一个字符）。所以草稿留在本页，失焦或点按钮时才写。
 * 选择类（主题/同步方式）用 saveNow：点一下就落库，不需要"保存"按钮。
 */
export function useSettingsDraft(
  store: AppStore,
  settings: SettingsMap,
): {
  value: (key: string) => string;
  update: (key: string, next: string) => void;
  commit: (key: string) => void;
  saveNow: (key: string, next: string) => void;
} {
  const [local, setLocal] = useState<Record<string, string>>({});

  // 从 store 同步一次（首次加载完成后）；已有的草稿不覆盖
  useEffect(() => {
    setLocal((current) => {
      const next = { ...current };
      for (const key of Object.values(SETTING_KEYS)) {
        if (next[key] === undefined && settings[key] !== undefined) next[key] = settings[key] as string;
      }
      return next;
    });
  }, [settings]);

  const value = (key: string): string => local[key] ?? settings[key] ?? '';
  const update = (key: string, next: string): void => setLocal((current) => ({ ...current, [key]: next }));
  const commit = (key: string): void => {
    const next = value(key);
    if (next === (settings[key] ?? '')) return;
    void store.actions.setSetting(key, next);
  };
  const saveNow = (key: string, next: string): void => {
    update(key, next);
    void store.actions.setSetting(key, next);
  };

  return { value, update, commit, saveNow };
}
