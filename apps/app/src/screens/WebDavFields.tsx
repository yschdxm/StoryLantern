import type { ReactNode } from 'react';
import { Field, TextInput } from '../ui/components.tsx';
import { SETTING_KEYS } from '../data/types.ts';
import { useT } from '../i18n/context.tsx';

/**
 * WebDAV 后端要填的字段（地址 / 用户名 / 密码）。
 *
 * 抽出来的原因与 `S3Fields` 一样：设置页贴着"每文件 400 行"的门禁上限，多一个后端就顶破一次。
 * 密码是**非机密**（HTTP Basic 的密码不是我们的密钥，进设置即可）；真正的同步口令是另一个字段，
 * 它只写、只存设备本地 kv。
 */
export interface WebDavFieldsProps {
  value(key: string): string;
  update(key: string, next: string): void;
  commit(key: string): void;
}

export function WebDavFields(props: WebDavFieldsProps): ReactNode {
  const t = useT();
  return (
    <>
      <Field label={t('settings.sync.url')} hint={t('settings.sync.url.hint')}>
        <TextInput
          type="url"
          value={props.value(SETTING_KEYS.syncUrl)}
          placeholder="https://nas.local:5006/storylantern/"
          onChange={(next) => props.update(SETTING_KEYS.syncUrl, next)}
          onBlur={() => props.commit(SETTING_KEYS.syncUrl)}
        />
      </Field>
      <Field label={t('settings.sync.username')}>
        <TextInput
          value={props.value(SETTING_KEYS.syncUsername)}
          onChange={(next) => props.update(SETTING_KEYS.syncUsername, next)}
          onBlur={() => props.commit(SETTING_KEYS.syncUsername)}
        />
      </Field>
      <Field label={t('settings.sync.password')}>
        <TextInput
          type="password"
          value={props.value(SETTING_KEYS.syncPassword)}
          onChange={(next) => props.update(SETTING_KEYS.syncPassword, next)}
          onBlur={() => props.commit(SETTING_KEYS.syncPassword)}
        />
      </Field>
    </>
  );
}
