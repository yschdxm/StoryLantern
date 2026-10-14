import { useEffect, useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useAppState } from './screen-props.ts';
import { Button, ConfirmDialog, Field, TextArea, TextInput } from '../ui/components.tsx';

export interface CharacterEditScreenProps extends ScreenProps {
  characterId: number | 'new';
  onDone: (characterId: number) => void;
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
  const state = useAppState(store);
  const existing = characterId === 'new' ? undefined : state.characters.find((item) => item.id === characterId);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [personality, setPersonality] = useState('');
  const [scenario, setScenario] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [exampleDialogue, setExampleDialogue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [loadedId, setLoadedId] = useState<number | undefined>(undefined);
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
        <Field label="名字" hint="必填，最多 60 字">
          <TextInput value={name} onChange={setName} placeholder="例如：星野" autoFocus={isNew} />
        </Field>
        <Field label="描述" hint="她是谁、长什么样、什么身份">
          <TextArea value={description} onChange={setDescription} rows={4} placeholder="夜巡的守望者，话不多但记得每一个名字。" />
        </Field>
        <Field label="性格" hint="语气、习惯、在意什么">
          <TextArea value={personality} onChange={setPersonality} rows={3} placeholder="克制、敏锐、对旧物有执念。" />
        </Field>
        <Field label="场景" hint="对话发生在哪里、什么时候">
          <TextArea value={scenario} onChange={setScenario} rows={3} placeholder="雪线之上的隘口，灯火将尽。" />
        </Field>
        <Field label="开场白" hint="新建会话时自动出现的这句话">
          <TextArea value={firstMessage} onChange={setFirstMessage} rows={3} placeholder="「进来吧，风会替你关门。」" />
        </Field>
        <Field label="示例对话" hint="给她一两轮示范，模型会照着这个语气走">
          <TextArea
            value={exampleDialogue}
            onChange={setExampleDialogue}
            rows={4}
            placeholder={'{{user}}: 你守了多久？\n{{char}}: 久到忘了数。'}
          />
        </Field>

        {!isNew && (
          <div className="form__danger">
            <Button variant="ghost" onClick={() => setPendingDelete(true)}>
              删除这个角色
            </Button>
          </div>
        )}
      </div>

      <div className="actionbar">
        <Button block disabled={busy || name.trim() === ''} onClick={() => void save()}>
          {busy ? '保存中…' : isNew ? '创建角色' : '保存'}
        </Button>
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title="删除角色"
        message={`「${existing?.name ?? name}」以及它的所有会话和消息都会被删除，无法恢复。`}
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          setPendingDelete(false);
          if (!isNew) void store.actions.deleteCharacter(characterId);
          onDone(-1);
        }}
      />
    </div>
  );
}
