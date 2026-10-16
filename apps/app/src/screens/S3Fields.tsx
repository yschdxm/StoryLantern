import type { ReactNode } from 'react';
import { Field, TextInput } from '../ui/components.tsx';
import { SETTING_KEYS } from '../data/types.ts';
import { useT } from '../i18n/context.tsx';

/**
 * S3 兼容后端（MinIO / R2 / B2 / AWS）要填的字段。
 *
 * 拆成独立组件有两个原因：设置页已经贴着"每文件 400 行"的门禁上限，塞进五个字段会顶破；
 * 以及 S3 的字段以后还会长（路径式/虚拟主机式、会话令牌），放在一处更好改。
 *
 * Secret Key 与同步口令一样是**只写**的：界面不回显、不写进设置（宿主对 secret 类键只回掩码，
 * 写回去会把真密钥覆盖成 `••••••`——真机上踩过），由父组件在点同步时收集后写设备本地 kv。
 */
export interface S3FieldsProps {
  /** 读一个设置键的当前值（父组件的草稿态，不是已落库的值）。 */
  value(key: string): string;
  update(key: string, next: string): void;
  commit(key: string): void;
  /** Secret Key 的本地草稿（只写，不落设置）。 */
  secretDraft: string;
  onSecretDraft(next: string): void;
}

export function S3Fields(props: S3FieldsProps): ReactNode {
  const t = useT();
  const text = (key: string, placeholder: string): ReactNode => (
    <TextInput
      value={props.value(key)}
      placeholder={placeholder}
      onChange={(next) => props.update(key, next)}
      onBlur={() => props.commit(key)}
    />
  );

  return (
    <>
      <Field label={t('settings.sync.s3.endpoint')} hint={t('settings.sync.s3.endpoint.hint')}>
        {text(SETTING_KEYS.syncS3Endpoint, 'http://127.0.0.1:9000')}
      </Field>
      <Field label={t('settings.sync.s3.bucket')}>{text(SETTING_KEYS.syncS3Bucket, 'storylantern')}</Field>
      <Field label={t('settings.sync.s3.region')} hint={t('settings.sync.s3.region.hint')}>
        {text(SETTING_KEYS.syncS3Region, 'us-east-1')}
      </Field>
      <Field label={t('settings.sync.s3.accessKeyId')} hint={t('settings.sync.s3.accessKeyId.hint')}>
        {text(SETTING_KEYS.syncS3AccessKeyId, 'minioadmin')}
      </Field>
      <Field label={t('settings.sync.s3.secret')} hint={t('settings.sync.s3.secret.hint')}>
        {/* Secret Key **只写**：既不回显明文也不回显掩码 */}
        <TextInput
          type="password"
          value={props.secretDraft}
          placeholder={t('settings.sync.s3.secret.placeholder')}
          onChange={props.onSecretDraft}
        />
      </Field>
    </>
  );
}

/** S3 的四个非机密设置键：父组件点同步前要把它们落库（与 WebDAV 那段同一个理由）。 */
export const S3_SETTING_KEYS = [
  SETTING_KEYS.syncS3Endpoint,
  SETTING_KEYS.syncS3Bucket,
  SETTING_KEYS.syncS3Region,
  SETTING_KEYS.syncS3AccessKeyId,
] as const;
