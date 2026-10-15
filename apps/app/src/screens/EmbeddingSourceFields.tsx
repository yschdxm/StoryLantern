import { useState, type ReactNode } from 'react';
import type { WireTransport } from '../../../../packages/wire/src/index.ts';
import type { AppStore } from '../app/state.ts';
import { formatResolved, probeEmbedding, type WireEmbedResolved } from '../data/embedding-host.ts';
import { SETTING_KEYS } from '../data/types.ts';
import { useT } from '../i18n/context.tsx';
import { Banner, Button, Field, TextInput } from '../ui/components.tsx';

/**
 * 「向量来源」三格：地址 / 模型 / 密钥。
 *
 * **为什么独立成三格**：文本模型与向量模型常常不是同一家 —— 例如文本走 DeepSeek 官方、
 * 向量走 moark。以前向量继承聊天那份配置，一旦文本换成官方，向量就会被发去
 * api.deepseek.com/embeddings（那里没有这个接口），必然失败。
 *
 * **为什么用本地草稿 + 失焦落库**（而不是每次按键就写设置）：这两格是受控输入，value 来自设置；
 * 若每次按键立刻 setSetting，下一次按键会先被"设置里还没更新的旧值"覆盖回来 —— 实测结果是
 * **只留下最后一个字符**（地址变成 1、模型变成 B）。所以草稿留本地，失焦或点按钮时才写。
 *
 * **密钥纪律**：写进去只存在宿主数据库（store.rs 里 api_key 这类键在 wire 上只回掩码），
 * 所以这两格**只写不读**：界面只知道"已配置/未配置"，拿不到明文。
 */
export function EmbeddingSourceFields({
  store,
  settings,
  transport,
}: {
  store: AppStore;
  settings: Record<string, string>;
  transport?: WireTransport;
}): ReactNode {
  const t = useT();
  const [baseUrlDraft, setBaseUrlDraft] = useState(settings[SETTING_KEYS.embeddingBaseUrl] ?? '');
  const [modelDraft, setModelDraft] = useState(settings[SETTING_KEYS.embeddingModel] ?? '');
  const [apiKey, setApiKey] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const hasKey = (settings[SETTING_KEYS.embeddingApiKey] ?? '') !== '';

  /** 把草稿落库（失焦或点按钮时调用；空串也照写，以便清空）。 */
  const commit = async (): Promise<void> => {
    await store.actions.setSetting(SETTING_KEYS.embeddingBaseUrl, baseUrlDraft.trim());
    await store.actions.setSetting(SETTING_KEYS.embeddingModel, modelDraft.trim());
  };

  const saveKey = async (): Promise<void> => {
    if (apiKey.trim() === '') return;
    await store.actions.setSetting(SETTING_KEYS.embeddingApiKey, apiKey.trim());
    setApiKey('');
  };

  const test = async (): Promise<void> => {
    if (transport === undefined) return;
    setBusy(true);
    setNote(t('settings.vector.testing'));
    try {
      // 先把草稿落库再自检 —— 否则测的是"上一次保存的值"，很容易被看成"填了没用"
      await commit();
      const result = await probeEmbedding({
        transport,
        ...(modelDraft.trim() === '' ? {} : { model: modelDraft.trim() }),
      });
      const head = result.ok ? t('settings.vector.ok', { dims: result.dimensions, ms: result.ms }) : result.message;
      const resolved: WireEmbedResolved | undefined = result.resolved;
      setNote(head + (resolved === undefined ? '' : '\n' + formatResolved(resolved)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-group">
      <h2 className="settings-group__title">{t('settings.vector.title')}</h2>
      <p className="muted">{t('settings.vector.hint')}</p>
      <Field label={t('settings.vector.baseUrl')} hint={t('settings.vector.baseUrl.hint')}>
        <TextInput
          type="url"
          value={baseUrlDraft}
          placeholder="https://api.moark.com/v1"
          onChange={setBaseUrlDraft}
          onBlur={() => void commit()}
        />
      </Field>
      <Field label={t('settings.vector.model')} hint={t('settings.vector.model.hint')}>
        <TextInput
          value={modelDraft}
          placeholder="Qwen3-Embedding-8B"
          onChange={setModelDraft}
          onBlur={() => void commit()}
        />
      </Field>
      <Field label={t('settings.vector.apiKey')} hint={t('settings.vector.apiKey.hint')}>
        {/* 只写不读：宿主只回掩码，写回掩码会覆盖真密钥（同步口令上踩过一次） */}
        <TextInput
          type="password"
          value={apiKey}
          placeholder={hasKey ? t('settings.models.key.saved') : t('settings.models.key.placeholder')}
          onChange={setApiKey}
        />
      </Field>
      <div className="row">
        <Button variant="ghost" disabled={apiKey.trim() === ''} onClick={() => void saveKey()}>
          {t('settings.vector.saveKey')}
        </Button>
        {transport !== undefined && (
          <Button disabled={busy} onClick={() => void test()}>
            {t('settings.vector.test')}
          </Button>
        )}
      </div>
      {note !== undefined && <Banner tone="info">{note}</Banner>}
    </div>
  );
}
