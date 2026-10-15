import { useState, type ReactNode } from 'react';
import { describeError } from '../data/error-text.ts';
import { ulid } from '../../../../packages/oplog/src/index.ts';
import type { AppStore } from '../app/state.ts';
import { DEFAULT_EMBEDDING_MODEL, formatResolved, probeEmbedding } from '../data/embedding-host.ts';
import { EmbeddingSourceFields } from './EmbeddingSourceFields.tsx';
import { useT } from '../i18n/context.tsx';
import type { WireTransport } from '../../../../packages/wire/src/index.ts';
import type { ChatClient } from '../data/chat-client.ts';
import {
  MODEL_TASKS,
  candidatesFor,
  profileKeySetting,
  readProfiles,
  serializeProfiles,
  type ModelProfile,
  type ModelTask,
} from '../data/model-routing.ts';
import { SETTING_KEYS } from '../data/types.ts';
import { createUsageStore, parseBudget, parsePriceTable } from '../data/usage-store.ts';
import { Banner, Button, ConfirmDialog, Field, ListRow, Sheet, SheetItem, TextInput } from '../ui/components.tsx';

/**
 * 模型配置（多模型路由）面板。
 *
 * 三条约定，都是为了避免"看起来配好了其实没生效"：
 *  - 元数据（名字/地址/模型名/参数/任务）存在**不掩码**的设置键里，密钥单独放在
 *    `model.profile.<id>.api_key`（这个键会被自动掩码，界面永远拿不到明文）；
 *  - 密钥框**只写**：不回显明文也不回显掩码，留空表示不改；
 *  - 列表顺序**就是**回退顺序，界面上直接写出来，而不是让用户猜。
 */
export function ModelProfilesPanel({ store, chat, settings, transport }: { store: AppStore; chat: ChatClient; settings: Record<string, string>; transport?: WireTransport }): ReactNode {
  const t = useT();
  const profiles = readProfiles(settings);
  const [editing, setEditing] = useState<ModelProfile | 'new' | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<string | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined);

  const save = async (next: ModelProfile[]): Promise<void> => {
    await store.actions.setSetting(SETTING_KEYS.modelProfiles, serializeProfiles(next));
  };

  const upsert = async (profile: ModelProfile, apiKey?: string): Promise<void> => {
    const next = profiles.some((item) => item.id === profile.id)
      ? profiles.map((item) => (item.id === profile.id ? profile : item))
      : [...profiles, profile];
    await save(next);
    if (apiKey !== undefined && apiKey !== '') await store.actions.setSetting(profileKeySetting(profile.id), apiKey);
  };

  const remove = async (id: string): Promise<void> => {
    await save(profiles.filter((item) => item.id !== id));
    // 顺手把密钥也清掉：删了配置还留着 key，属于"看不见的攻击面"
    await store.actions.setSetting(profileKeySetting(id), '');
  };

  // 用量与预算（M4 判据 3）：价格表/预算是用户手填的，非法输入必须当场说清楚，
  // 不能静默当空——否则会以为「填了价格却没生效」。
  const usage = createUsageStore({
    settings: () => store.getState().settings,
    setSetting: (key, value) => store.actions.setSetting(key, value),
  });
  const [pricesDraft, setPricesDraft] = useState(settings[SETTING_KEYS.usagePrices] ?? '');
  const [budgetDraft, setBudgetDraft] = useState(settings[SETTING_KEYS.usageBudgetUsd] ?? '');
  const [usageNote, setUsageNote] = useState<string | undefined>(undefined);
  const [usageError, setUsageError] = useState<string | undefined>(undefined);
  const usageTotals = usage.totals();

  /** 用**刚填的内容**直接解析（而不是等设置回读），这样报错说的就是用户刚敲的那一行。 */
  const saveUsageConfig = async (): Promise<void> => {
    setUsageError(undefined);
    setUsageNote(undefined);
    const parsedPrices = parsePriceTable(pricesDraft);
    const parsedBudget = parseBudget(budgetDraft);
    if (parsedPrices.error !== undefined) {
      setUsageError(parsedPrices.error);
      return;
    }
    if (parsedBudget.error !== undefined) {
      setUsageError(parsedBudget.error);
      return;
    }
    await store.actions.setSetting(SETTING_KEYS.usagePrices, pricesDraft.trim());
    await store.actions.setSetting(SETTING_KEYS.usageBudgetUsd, budgetDraft.trim());
    setUsageNote(t('settings.usage.saved'));
  };

  const menu = profiles.find((item) => item.id === menuFor);
  const deleting = profiles.find((item) => item.id === confirmDelete);
  // 当前"对话"会用哪一份（让"顺序即回退链"这句话有具体所指）
  const chatChain = candidatesFor(settings, 'chat');

  return (
    <>
      <p className="muted">{t('settings.models.hint')}</p>

      {profiles.length > 0 && (
        <p className="muted">
          {chatChain.length === 0
            ? t('settings.models.chain.none')
            : t('settings.models.chain', { chain: chatChain.map((item) => item.name).join(' → ') })}
        </p>
      )}

      {profiles.length > 0 && (
        <ul className="list">
          {profiles.map((profile) => (
            <ListRow
              key={profile.id}
              title={profile.name}
              subtitle={profile.model === '' ? t('settings.models.incomplete') : profile.model}
              meta={[
                profile.tasks.length === 0
                  ? t('settings.models.fallback')
                  : profile.tasks.map((task) => t(`settings.models.task.${task}`)).join('、'),
                profile.enabled ? '' : t('lore.off'),
              ]
                .filter((part) => part !== '')
                .join(' · ')}
              onClick={() => setEditing(profile)}
              onLongPress={() => setMenuFor(profile.id)}
            />
          ))}
        </ul>
      )}

      <div className="row">
        <Button onClick={() => setEditing('new')}>{t('settings.models.add')}</Button>
      </div>
      <p className="muted">{t('settings.models.keyNote')}</p>

      <Sheet
        open={editing !== undefined}
        title={editing === 'new' ? t('settings.models.add') : t('settings.models.edit')}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <ProfileForm
            profile={editing === 'new' ? undefined : editing}
            chat={chat}
            settings={settings}
            {...(transport === undefined ? {} : { transport })}
            onSave={async (profile, apiKey) => {
              await upsert(profile, apiKey);
            }}
            onDone={async (profile, apiKey) => {
              await upsert(profile, apiKey);
              setEditing(undefined);
            }}
          />
        )}
      </Sheet>

      <Sheet open={menu !== undefined} title={menu?.name} onClose={() => setMenuFor(undefined)}>
        <SheetItem
          icon="edit"
          label={t('settings.models.edit')}
          onClick={() => {
            const profile = menu;
            setMenuFor(undefined);
            if (profile !== undefined) setEditing(profile);
          }}
        />
        <SheetItem
          icon="trash"
          label={t('common.delete')}
          danger
          onClick={() => {
            const id = menu?.id;
            setMenuFor(undefined);
            setConfirmDelete(id);
          }}
        />
      </Sheet>

      <ConfirmDialog
        open={deleting !== undefined}
        title={t('settings.models.delete.title')}
        message={t('settings.models.delete.message', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onCancel={() => setConfirmDelete(undefined)}
        onConfirm={() => {
          const id = confirmDelete;
          setConfirmDelete(undefined);
          if (id !== undefined) void remove(id);
        }}
      />

      <EmbeddingSourceFields store={store} settings={settings} {...(transport === undefined ? {} : { transport })} />
      <h3 className='section__title'>{t('settings.usage.title')}</h3>
      <Field label={t('settings.usage.prices')} hint={t('settings.usage.prices.hint')}>
        <TextInput value={pricesDraft} onChange={setPricesDraft} placeholder='[{"modelId":"deepseek-chat","promptPer1k":0.00027,"completionPer1k":0.0011}]' />
      </Field>
      <Field label={t('settings.usage.budget')} hint={t('settings.usage.budget.hint')}>
        <TextInput value={budgetDraft} onChange={setBudgetDraft} placeholder='5' />
      </Field>
      <div className='row'>
        <Button onClick={() => void saveUsageConfig()}>{t('common.save')}</Button>
      </div>
      {usageError !== undefined && <p className='notice notice--warn'>{usageError}</p>}
      {usageNote !== undefined && <p className='muted'>{usageNote}</p>}
      <p className='muted'>
        {t('settings.usage.summary', {
          requests: usageTotals.requests,
          cost: usageTotals.costUsd.toFixed(4),
          prompt: usageTotals.promptTokens,
          completion: usageTotals.completionTokens,
        })}
      </p>
      {usageTotals.unpricedRequests > 0 && (
        <p className='muted'>{t('settings.usage.unpriced', { count: usageTotals.unpricedRequests })}</p>
      )}
    </>
  );
}

function ProfileForm({
  profile,
  chat,
  settings,
  transport,
  onSave,
  onDone,
}: {
  profile?: ModelProfile | undefined;
  chat: ChatClient;
  settings: Record<string, string>;
  /** 保存但**不**关面板：这样"保存并测试"的结果能立刻看到。 */
  transport?: WireTransport;
  onSave: (profile: ModelProfile, apiKey?: string) => Promise<void>;
  /** 保存并让调用方关闭面板。 */
  onDone: (profile: ModelProfile, apiKey?: string) => Promise<void>;
}): ReactNode {
  const t = useT();
  const [id] = useState(() => profile?.id ?? ulid());
  const [name, setName] = useState(profile?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(profile?.baseUrl ?? '');
  const [model, setModel] = useState(profile?.model ?? '');
  const [temperature, setTemperature] = useState(String(profile?.temperature ?? 0.9));
  const [maxTokens, setMaxTokens] = useState(String(profile?.maxTokens ?? 1024));
  // 新配置默认标"对话"：别让用户在"为什么没生效"上浪费一次
  const [tasks, setTasks] = useState<ModelTask[]>(profile?.tasks ?? ['chat']);
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | undefined>(undefined);
  const [vectorProbe, setVectorProbe] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // 密钥是否已存过：宿主只回掩码（非空字符串），因此"非空即已存"，明文永远不会到这里
  const hasKey = (settings[profileKeySetting(id)] ?? '') !== '';

  const toggleTask = (task: ModelTask): void => {
    setTasks((current) => (current.includes(task) ? current.filter((item) => item !== task) : [...current, task]));
  };

  const build = (): ModelProfile => ({
    id,
    name: name.trim() === '' ? t('settings.models.untitled') : name.trim(),
    baseUrl: baseUrl.trim(),
    model: model.trim(),
    temperature: Number.isFinite(Number(temperature)) && Number(temperature) > 0 ? Number(temperature) : 0.9,
    maxTokens: Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? Math.floor(Number(maxTokens)) : 1024,
    tasks,
    enabled,
  });

  /** 保存；`after` 在保存成功、密钥清空后才执行（测试连接靠它保证"测的是刚保存的那份"）。 */
  const persist = async (after?: () => Promise<void> | void): Promise<void> => {
    setError(undefined);
    setBusy(true);
    try {
      await onSave(build(), apiKey);
      setApiKey('');
      await after?.();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet__form">
      <Field label={t('settings.models.name')}>
        <TextInput value={name} onChange={setName} placeholder={t('settings.models.name.placeholder')} />
      </Field>
      <Field label={t('settings.models.baseUrl')} hint={t('settings.sync.url.hint')}>
        <TextInput type="url" value={baseUrl} onChange={setBaseUrl} placeholder="https://api.deepseek.com/v1" />
      </Field>
      <Field label={t('settings.models.model')}>
        <TextInput value={model} onChange={setModel} placeholder="deepseek-chat" />
      </Field>
      <Field label={t('settings.models.key')} hint={t('settings.models.keyNote')}>
        {/* 只写：不回显明文也不回显掩码（掩码写回去会覆盖真密钥——同步口令上踩过一次） */}
        <TextInput
          type="password"
          value={apiKey}
          placeholder={hasKey ? t('settings.models.key.saved') : t('settings.models.key.placeholder')}
          onChange={setApiKey}
        />
      </Field>
      <Field label={t('settings.models.temperature')}>
        <TextInput type="number" value={temperature} onChange={setTemperature} />
      </Field>
      <Field label={t('settings.models.maxTokens')}>
        <TextInput type="number" value={maxTokens} onChange={setMaxTokens} />
      </Field>
      <Field label={t('settings.models.tasks')} hint={t('settings.models.tasks.none')}>
        <div className="chips">
          {MODEL_TASKS.map((task) => (
            <button
              key={task}
              type="button"
              className={`chip${tasks.includes(task) ? ' chip--on' : ''}`}
              onClick={() => toggleTask(task)}
            >
              {t(`settings.models.task.${task}`)}
            </button>
          ))}
        </div>
      </Field>
      <Field label={t('settings.models.enabled')}>
        <div className="segmented" role="group">
          <button
            type="button"
            className={`segmented__item${enabled ? ' segmented__item--active' : ''}`}
            aria-pressed={enabled}
            onClick={() => setEnabled(true)}
          >
            {t('lore.on')}
          </button>
          <button
            type="button"
            className={`segmented__item${enabled ? '' : ' segmented__item--active'}`}
            aria-pressed={!enabled}
            onClick={() => setEnabled(false)}
          >
            {t('lore.off')}
          </button>
        </div>
      </Field>

      {error !== undefined && <p className="notice notice--warn">{error}</p>}
      {probe !== undefined && <Banner tone={probe.ok ? 'info' : 'error'}>{probe.message}</Banner>}
      {transport !== undefined && (
        <div className="row">
          <Button
            variant="ghost"
            onClick={() => {
              setVectorProbe(t('settings.vector.testing'));
              void probeEmbedding({
                transport,
                // 必须用 profile.id：表单里的 id 不是这份配置的 id（真机上因此把空 profileId 传给了宿主，
                // 宿主退回到空地址的兜底配置，报「还没有配置接口地址与模型名」）
                ...(profile === undefined || profile.id === '' ? {} : { profileId: profile.id }),
                // 向量模型 id：设置里没有就用默认（否则宿主会拿**聊天**模型去调 /embeddings，必然失败）
                // 地址与密钥都沿用当前这份配置 —— 密钥不进前端，宿主自己读
                model: settings[SETTING_KEYS.embeddingModel] ?? DEFAULT_EMBEDDING_MODEL,
              }).then((result) =>
                setVectorProbe(
                  (result.ok ? t('settings.vector.ok', { dims: result.dimensions, ms: result.ms }) : result.message) +
                    (result.resolved === undefined ? '' : '\n' + formatResolved(result.resolved)),
                ),
              );
            }}
          >
            {t('settings.vector.test')}
          </Button>
        </div>
      )}
      {vectorProbe !== undefined && <Banner tone="info">{vectorProbe}</Banner>}

      <div className="row">
        <Button
          disabled={busy}
          onClick={() =>
            void persist(() => chat.probe(id).then((result) => setProbe(result)))
          }
        >
          {busy ? t('settings.models.testing') : t('settings.models.test')}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void persist(() => {
              onDone(build());
            })
          }
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
