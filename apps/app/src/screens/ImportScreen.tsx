import { useRef, useState, type ReactNode } from 'react';
import { describeError } from '../data/error-text.ts';
import type { ScreenProps } from './screen-props.ts';
import { useT } from '../i18n/context.tsx';
import { importFile, importText, type Imported } from '../../../../packages/importer/src/index.ts';
import { chatImportPlan } from '../data/import-bridge.ts';
import { planCharacterImport, planLorebookImport } from '../data/import-cards.ts';
import { Banner, Button, EmptyState, Icon } from '../ui/components.tsx';

/**
 * 导入页。
 *
 * 两条输入路径都留着：**选文件**（手机上是系统文件选择器）与**粘贴文本**。
 * 后者的价值不只是兜底——桌面用户拿到一段卡 JSON 时，粘贴比"先存成文件再选"快得多。
 *
 * 落库走**卡片模型**（ADR-0011）：角色 → `cards.save` + 兼容草稿；内嵌/独立世界书 →
 * `packs.save` + 逐条典籍卡。旧 `characters.save/lorebooks.save` 只留给聊天记录导入这条旧路径。
 * 结果逐条显示：成功给名字与转存/丢弃提示，失败给原因，绝不出现"点了没反应"。
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
  const [notes, setNotes] = useState<string[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
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
        addError(file.name, describeError(cause));
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
      addError('（粘贴的内容）', describeError(cause));
    }
  };

  /**
   * 把解析结果写进仓储。
   *
   * 每一项独立 try/catch：一项校验失败不能拖垮整批（部分成功是常态），失败原因逐条可见。
   * 卡片仓储缺失（浏览器最小实现）时如实提示，而不是退回旧写入路径假装成功。
   */
  const applyImport = async (): Promise<void> => {
    setBusy(true);
    setSummary(undefined);
    setNotes([]);
    setFailures([]);
    const cards = store.repository.cards;
    const packs = store.repository.packs;
    const stash = store.repository.stash;
    let characters = 0;
    let sessions = 0;
    let lorebooks = 0;
    let entries = 0;
    let skippedCount = 0;
    const notices: string[] = [];
    const problems: string[] = [];
    try {
      const existingNames = new Set(cards === undefined ? [] : (await cards.list('character')).map((card) => card.meta.name));
      for (const item of items) {
        const result = item.result;
        try {
          if (result.kind === 'character') {
            if (cards === undefined) {
              problems.push(t('world.editor.noCards'));
              continue;
            }
            // 同名角色不再建一份：重复导入同一张卡很容易发生，静默造重复是最烦人的结果
            if (existingNames.has(result.name)) {
              skippedCount += 1;
              continue;
            }
            const plan = planCharacterImport(result, { now: Date.now() });
            await cards.save(plan.card);
            existingNames.add(plan.card.meta.name);
            characters += 1;
            if (stash !== undefined) {
              for (const entry of plan.stash) await stash.save(entry);
            }
            if (plan.pack !== undefined && packs !== undefined) {
              await packs.save(plan.pack);
              lorebooks += 1;
            }
            for (const loreCard of plan.loreCards) {
              await cards.save(loreCard);
              entries += 1;
            }
            notices.push(...plan.notes);
          } else if (result.kind === 'lorebook') {
            if (cards === undefined) {
              problems.push(t('import.noCards'));
              continue;
            }
            const plan = planLorebookImport(result.lorebook, { now: Date.now() });
            if (packs !== undefined) {
              await packs.save(plan.pack);
              lorebooks += 1;
            }
            for (const card of plan.cards) {
              await cards.save(card);
              entries += 1;
            }
            notices.push(...plan.notes);
          } else if (result.kind === 'chat') {
            // 聊天记录仍走旧路径：角色/会话/消息都是旧模型，本任务不改它
            const plan = chatImportPlan(result, store.getState().characters);
            let characterId = plan.existingCharacter?.id;
            if (characterId === undefined) {
              characterId = (await store.actions.saveCharacter({ name: plan.characterName })).id;
              characters += 1;
            }
            const session = await store.actions.createSession(characterId, plan.title);
            sessions += 1;
            // 批量写入：整本历史只发生**一次**仓储写入（真机上逐条 append 会慢到不可用）
            await store.actions.appendMany(
              session.id,
              plan.messages.map((message) => ({
                role: message.role,
                content: message.content,
                ...(message.createdAt === undefined ? {} : { createdAt: message.createdAt }),
                ...(message.candidates.length === 0 ? {} : { candidates: message.candidates }),
              })),
            );
            await store.actions.refreshSessions();
          }
        } catch (cause) {
          // 部分失败：原因逐条可见（文件名 + 四段式错误文本由 describeError 提供）
          problems.push(`${item.fileName}：${describeError(cause)}`);
        }
      }

      setSkipped(skippedCount);
      setNotes([...new Set(notices)]);
      setFailures([...new Set(problems)]);
      setSummary(
        t('import.done', {
          characters: t('count.characters', { count: characters }),
          sessions: t('count.sessions', { count: sessions }),
          ...(lorebooks === 0 ? {} : { lore: t('import.lore', { books: lorebooks, entries }) }),
        }),
      );
      if (problems.length === 0) setItems([]);
      // 卡片导入不经过 store.actions.saveCharacter：最后统一刷新一次，列表页立刻看得到
      await store.actions.refresh();
    } catch (cause) {
      setFailures([describeError(cause)]);
    } finally {
      setBusy(false);
    }
  };

  const importable = items.filter(
    (item) => item.result.kind === 'character' || item.result.kind === 'chat' || item.result.kind === 'lorebook',
  ).length;

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

      {failures.length > 0 && (
        <Banner tone="error">
          {failures.map((failure, index) => (
            <span key={`${failure}-${String(index)}`}>
              {index === 0 ? '' : <br />}
              {t('import.failed', { message: failure })}
            </span>
          ))}
        </Banner>
      )}

      {notes.length > 0 && (
        <Banner tone="info">
          {notes.map((note, index) => (
            <span key={`${note}-${String(index)}`}>
              {index === 0 ? '' : <br />}
              {note}
            </span>
          ))}
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
              const itemNotes = 'notes' in result ? result.notes : [];
              return (
                <li key={item.id} className={`file-row file-row--${ok ? 'ok' : 'fail'}`}>
                  <span className="file-row__name">
                    {label}
                    {itemNotes.length > 0 && <span className="file-row__note"> · {itemNotes.join('；')}</span>}
                  </span>
                  <span className="file-row__note">{item.fileName}</span>
                </li>
              );
            })}
          </ul>

          <Button block disabled={busy || importable === 0} onClick={() => void applyImport()}>
            {busy ? t('common.saving') : t('import.action', { count: importable })}
          </Button>
        </>
      )}
    </div>
  );
}
