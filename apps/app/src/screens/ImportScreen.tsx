import { useRef, useState, type ReactNode } from 'react';
import type { ScreenProps } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import { importFile, importText, type Imported } from '../../../../packages/importer/src/index.ts';
import { characterDraftFrom, chatImportPlan } from '../data/import-bridge.ts';
import { Banner, Button, EmptyState, Icon } from '../ui/components.tsx';

/**
 * 导入页。
 *
 * 两条路径都留着：**选文件**（手机上是系统文件选择器）与**粘贴文本**。
 * 后者的价值不只是兜底——桌面用户拿到一段卡 JSON 时，粘贴比"先存成文件再选"快得多。
 *
 * 导入结果逐条显示：成功给名字，失败给原因，绝不出现"点了没反应"。
 */

interface ParsedItem {
  id: number;
  fileName: string;
  result: Imported;
}

export function ImportScreen({ store, router }: ScreenProps): ReactNode {
  const t = useT();
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | undefined>(undefined);
  const [skipped, setSkipped] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sequence = useRef(0);

  const add = (fileName: string, result: Imported): void => {
    sequence.current += 1;
    const id = sequence.current;
    setItems((current) => [...current, { id, fileName, result }]);
  };

  const addError = (fileName: string, message: string): void => {
    add(fileName, { kind: 'unknown', source: fileName, reason: message });
  };

  const readFiles = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return;
    setBusy(true);
    setSummary(undefined);
    for (const file of Array.from(files)) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        add(file.name, await importFile(file.name, bytes));
      } catch (cause) {
        addError(file.name, cause instanceof Error ? cause.message : String(cause));
      }
    }
    setBusy(false);
  };

  const parsePasted = (): void => {
    const text = pasted.trim();
    if (text === '') return;
    try {
      add('（粘贴的内容）', importText('pasted.json', text));
      setPasted('');
    } catch (cause) {
      addError('（粘贴的内容）', cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** 把解析结果写进仓储：角色直接建；聊天记录按角色名找到（或建）角色再建会话。 */
  const applyImport = async (): Promise<void> => {
    setBusy(true);
    setSummary(undefined);
    let characters = 0;
    let sessions = 0;
    let skipped = 0;
    try {
      for (const item of items) {
        const result = item.result;
        if (result.kind === 'character') {
          // 同名角色不再建一份：重复导入同一张卡很容易发生，静默造重复是最烦人的结果
          if (store.getState().characters.some((character) => character.name === result.name)) {
            skipped += 1;
            continue;
          }
          const saved = await store.actions.saveCharacter(characterDraftFrom(result));
          characters += 1;
          // 有开场白就顺手建一个会话，导入完能立刻开聊——不然用户还得自己找一遍
          if (result.firstMessage.trim() !== '') {
            await store.actions.createSession(saved.id);
            sessions += 1;
          }
        } else if (result.kind === 'chat') {
          const plan = chatImportPlan(result, store.getState().characters);
          let characterId = plan.existingCharacter?.id;
          if (characterId === undefined) {
            characterId = (await store.actions.saveCharacter({ name: plan.characterName })).id;
            characters += 1;
          }
          const session = await store.actions.createSession(characterId, plan.title);
          sessions += 1;
          for (const message of plan.messages) {
            await store.actions.appendMessage(session.id, message.role, message.content, {
              ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
            });
          }
          // 逐条追加时只做了就地更新；批量结束后对齐一次，列表摘要才是权威值
          await store.actions.refreshSessions();
        }
      }
      setSkipped(skipped);
      setSummary(
        t('import.done', {
          characters: t('count.characters', { count: characters }),
          sessions: t('count.sessions', { count: sessions }),
        }),
      );
      setItems([]);
    } catch (cause) {
      addError('导入', cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const importable = items.filter((item) => item.result.kind === 'character' || item.result.kind === 'chat').length;

  return (
    <div className="settings">
      <section className="settings-group">
        <p className="muted">{t('import.hint')}</p>
        {/* 刻意接受任意文件：Android 的文件选择器按 MIME 过滤，`.charx`/`.jsonl` 没有标准 MIME，
            写成扩展名列表会让这两种文件在系统选择器里变成灰色不可选（实测过）。
            我们本来就是按内容识别（见 importFile），所以不该按扩展名拦。 */}
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          multiple
          accept="*/*"
          onChange={(event) => void readFiles(event.target.files)}
        />
        <div className="row">
          <Button disabled={busy} onClick={() => inputRef.current?.click()}>
            <Icon name="import" size={18} />
            {t('import.pick')}
          </Button>
          {items.length > 0 && (
            <Button variant="ghost" onClick={() => setItems([])}>
              {t('common.close')}
            </Button>
          )}
        </div>
      </section>

      <section className="settings-group">
        <h2 className="settings-group__title">{t('import.paste')}</h2>
        <textarea
          className="textarea"
          rows={4}
          value={pasted}
          placeholder={t('import.paste.placeholder')}
          onChange={(event) => setPasted(event.target.value)}
        />
        <Button variant="ghost" disabled={pasted.trim() === ''} onClick={parsePasted}>
          {t('import.parse')}
        </Button>
      </section>

      {summary !== undefined && (
        <Banner tone="info">
          {summary}
          {skipped > 0 && ` · ${t('import.skipped', { count: skipped })}`}
        </Banner>
      )}

      {items.length === 0 ? (
        <EmptyState icon="import" title={t('import.empty')} hint={t('import.hint')} />
      ) : (
        <>
          <ul className="file-list">
            {items.map((item) => {
              const result = item.result;
              const ok = result.kind === 'character' || result.kind === 'chat' || result.kind === 'lorebook';
              const label =
                result.kind === 'character'
                  ? t('import.parsed.character', { name: result.name })
                  : result.kind === 'chat'
                    ? t('import.parsed.chat', { name: result.characterName, count: result.messages.length })
                    : result.kind === 'lorebook'
                      ? t('import.parsed.lorebook', { name: result.lorebook.name, count: result.lorebook.entries.length })
                      : t('import.parsed.unknown', { reason: result.reason });
              const notes = 'notes' in result ? result.notes : [];
              return (
                <li key={item.id} className={`file-row file-row--${ok ? 'ok' : 'fail'}`}>
                  <span className="file-row__name">
                    {label}
                    {notes.length > 0 && <span className="file-row__note"> · {notes.join('；')}</span>}
                  </span>
                  <span className="file-row__note">{item.fileName}</span>
                </li>
              );
            })}
          </ul>

          <Button block disabled={busy || importable === 0} onClick={() => void applyImport()}>
            {busy ? t('common.saving') : t('import.action', { count: importable })}
          </Button>
          <p className="muted">{t('import.lorebook.note')}</p>
        </>
      )}
    </div>
  );
}
