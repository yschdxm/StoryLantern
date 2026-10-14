import { useEffect, useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import { Button, ConfirmDialog, Field, TextArea, TextInput } from '../ui/components.tsx';

export interface CharacterEditScreenProps extends ScreenProps {
  characterId: string | 'new';
  onDone: (characterId: string) => void;
}

/**
 * 角色编辑器。
 *
 * 两条刻意的取舍：
 *  1. **只有"名字"必填**——新用户第一次打开要能立刻跑通"建角色 → 聊天"，而不是先填六个表单；
 *  2. **主操作固定在表单底部**（拇指区），顶栏只留标题/返回/菜单，
 *     这样不必把表单状态提升到外壳去渲染顶栏按钮。
 */
export function CharacterEditScreen({ store, characterId, onDone }: CharacterEditScreenProps): ReactNode {
  const t = useT();
  const state = useAppState(store);
  const existing = characterId === 'new' ? undefined : state.characters.find((item) => item.id === characterId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [personality, setPersonality] = useState('');
  const [scenario, setScenario] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [exampleDialogue, setExampleDialogue] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  /** 备选开场白在界面上是一行一条，保存时过滤空行。 */
  const [greetings, setGreetings] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [loadedId, setLoadedId] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState(false);

  // 角色是异步读出来的：到达后填充一次；用 loadedId 防止覆盖用户正在输入的内容
  useEffect(() => {
    if (existing === undefined || loadedId === existing.id) return;
    setName(existing.name);
    setDescription(existing.description);
    setPersonality(existing.personality);
    setScenario(existing.scenario);
    setFirstMessage(existing.firstMessage);
    setExampleDialogue(existing.exampleDialogue);
    setSystemPrompt(existing.systemPrompt);
    setGreetings(existing.alternateGreetings.join('\n'));
    setLoadedId(existing.id);
  }, [existing, loadedId]);

  const isNew = characterId === 'new';
  const busy = state.busy === 'saveCharacter';

  const save = async (): Promise<void> => {
    setError(undefined);
    try {
      const saved = await store.actions.saveCharacter({
        ...(isNew ? {} : { id: characterId }),
        name,
        description,
        personality,
        scenario,
        firstMessage,
        exampleDialogue,
        systemPrompt,
        alternateGreetings: greetings.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
      });
      onDone(saved.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="form-screen">
      <div className="form">
        {error !== undefined && <p className="notice notice--warn">{error}</p>}
        <Field label={t('character.name')} hint={t('character.name.hint')}>
          <TextInput value={name} onChange={setName} placeholder={t('character.name.placeholder')} autoFocus={isNew} />
        </Field>
        <Field label={t('character.description')} hint={t('character.description.hint')}>
          <TextArea
            value={description}
            onChange={setDescription}
            rows={4}
            placeholder={t('character.description.placeholder')}
          />
        </Field>
        <Field label={t('character.personality')} hint={t('character.personality.hint')}>
          <TextArea
            value={personality}
            onChange={setPersonality}
            rows={3}
            placeholder={t('character.personality.placeholder')}
          />
        </Field>
        <Field label={t('character.scenario')} hint={t('character.scenario.hint')}>
          <TextArea value={scenario} onChange={setScenario} rows={3} placeholder={t('character.scenario.placeholder')} />
        </Field>
        <Field label={t('character.greeting')} hint={t('character.greeting.hint')}>
          <TextArea
            value={firstMessage}
            onChange={setFirstMessage}
            rows={3}
            placeholder={t('character.greeting.placeholder')}
          />
        </Field>
        <Field label={t('character.example')} hint={t('character.example.hint')}>
          <TextArea
            value={exampleDialogue}
            onChange={setExampleDialogue}
            rows={4}
            placeholder={t('character.example.placeholder')}
          />
        </Field>
        <Field label={t('character.systemPrompt')} hint={t('character.systemPrompt.hint')}>
          <textarea
            className="input"
            rows={3}
            value={systemPrompt}
            placeholder={t('character.systemPrompt.placeholder')}
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
        </Field>
        <Field label={t('character.greetings')} hint={t('character.greetings.hint')}>
          <textarea
            className="input"
            rows={3}
            value={greetings}
            placeholder={t('character.greetings.placeholder')}
            onChange={(event) => setGreetings(event.target.value)}
          />
        </Field>

        {!isNew && (
          <div className="form__danger">
            <Button variant="ghost" onClick={() => setPendingDelete(true)}>
              {t('character.delete')}
            </Button>
          </div>
        )}
      </div>

      <div className="actionbar">
        <Button block disabled={busy || name.trim() === ''} onClick={() => void save()}>
          {busy ? t('common.saving') : isNew ? t('character.create') : t('character.save')}
        </Button>
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title={t('characters.delete')}
        message={t('characters.delete.message', { name: existing?.name ?? name })}
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          setPendingDelete(false);
          if (!isNew) void store.actions.deleteCharacter(characterId);
          onDone('');
        }}
      />
    </div>
  );
}
