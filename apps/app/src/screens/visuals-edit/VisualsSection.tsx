import { useState, type ReactNode } from 'react';
import { useT } from '../../i18n/context.tsx';
import { Button, Field, TextArea, TextInput } from '../../ui/components.tsx';
import {
  VISUAL_TYPES,
  VISUAL_VIEWS,
  emptyVisualDraft,
  withPrimary,
  type VisualDraft,
  type VisualView,
} from '../../data/visuals-form.ts';

/**
 * 「视觉设定」分区（角色 / 场景 / 物品 / 典籍共用）。
 *
 * 资产二进制通道还没接线：这轮只编辑**描述优先**的元数据（caption 必填，图片可后补）。
 * 列表按数组输入顺序展示；点标题行展开编辑；`is_primary` 是单选（保存时由
 * `visuals-form.ts` 再归一一次，防止两个主视觉）。
 */

function typeLabel(t: ReturnType<typeof useT>, type: string): string {
  return (VISUAL_TYPES as readonly string[]).includes(type) ? t(`visuals.type.${type}`) : type;
}

function viewLabel(t: ReturnType<typeof useT>, view: string): string {
  return (VISUAL_VIEWS as readonly string[]).includes(view) ? t(`visuals.view.${view}`) : view;
}

function captionPreview(caption: string, fallback: string): string {
  const flat = caption.replace(/\s+/g, ' ').trim();
  if (flat === '') return fallback;
  return flat.length > 44 ? `${flat.slice(0, 44)}…` : flat;
}

export function VisualsSection({
  drafts,
  onChange,
}: {
  drafts: readonly VisualDraft[];
  onChange: (next: VisualDraft[]) => void;
}): ReactNode {
  const t = useT();
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);

  const update = (id: string, patch: Partial<VisualDraft>): void => {
    onChange(drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  };
  const add = (): void => {
    const draft = emptyVisualDraft();
    onChange([...drafts, draft]);
    setExpandedId(draft.id);
  };

  return (
    <section className="settings-group">
      <h2 className="settings-group__title">{t('visuals.title')}</h2>
      <p className="field__hint">{t('visuals.hint')}</p>
      <p className="visual-note">{t('visuals.uploadUnavailable')}</p>
      {drafts.length === 0 && <p className="muted">{t('visuals.empty')}</p>}
      {drafts.map((draft) => {
        const open = expandedId === draft.id;
        const typeKnown = (VISUAL_TYPES as readonly string[]).includes(draft.type);
        return (
          <div className="visual-row" key={draft.id}>
            <div className="visual-row__head">
              <button
                type="button"
                className="visual-row__main"
                aria-expanded={open}
                onClick={() => setExpandedId(open ? undefined : draft.id)}
              >
                <span className="visual-row__caption">{captionPreview(draft.caption, t('visuals.caption.empty'))}</span>
                <span className="visual-row__meta">
                  {typeLabel(t, draft.type)}
                  {draft.isPrimary ? ` · ${t('visuals.isPrimary')}` : ''}
                </span>
              </button>
              <Button variant="ghost" onClick={() => onChange(drafts.filter((item) => item.id !== draft.id))}>
                {t('visuals.remove')}
              </Button>
            </div>
            {open && (
              <div className="visual-row__body">
                <Field label={t('visuals.type')}>
                  <select
                    className="input"
                    value={draft.type}
                    aria-label={t('visuals.type')}
                    onChange={(event) => update(draft.id, { type: event.target.value })}
                  >
                    {!typeKnown && <option value={draft.type}>{draft.type}</option>}
                    {VISUAL_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(`visuals.type.${type}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={`${t('visuals.caption')}*`} hint={t('visuals.caption.hint')}>
                  <TextArea
                    value={draft.caption}
                    onChange={(value) => update(draft.id, { caption: value })}
                    rows={3}
                    placeholder={t('visuals.caption.placeholder')}
                  />
                </Field>
                <Field label={t('visuals.path')} hint={t('visuals.path.hint')}>
                  <TextInput
                    value={draft.path}
                    onChange={(value) => update(draft.id, { path: value })}
                    placeholder={t('visuals.path.placeholder')}
                  />
                </Field>
                <Field label={t('visuals.tags')} hint={t('visuals.tags.hint')}>
                  <TextInput
                    value={draft.tags}
                    onChange={(value) => update(draft.id, { tags: value })}
                    placeholder={t('visuals.tags.placeholder')}
                  />
                </Field>
                <Field label={t('visuals.view')}>
                  <select
                    className="input"
                    value={draft.view}
                    aria-label={t('visuals.view')}
                    onChange={(event) => update(draft.id, { view: event.target.value as VisualView | '' })}
                  >
                    <option value="">{t('visuals.view.unset')}</option>
                    {VISUAL_VIEWS.map((view) => (
                      <option key={view} value={view}>
                        {viewLabel(t, view)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('visuals.binding')} hint={t('visuals.binding.hint')}>
                  <TextInput
                    value={draft.binding}
                    onChange={(value) => update(draft.id, { binding: value })}
                    placeholder={t('visuals.binding.placeholder')}
                  />
                </Field>
                <Field label={t('visuals.renderPrompt')} hint={t('visuals.renderPrompt.hint')}>
                  <TextArea
                    value={draft.renderPrompt}
                    onChange={(value) => update(draft.id, { renderPrompt: value })}
                    rows={2}
                    placeholder={t('visuals.renderPrompt.placeholder')}
                  />
                </Field>
                <Field label={t('visuals.notes')}>
                  <TextArea value={draft.notes} onChange={(value) => update(draft.id, { notes: value })} rows={2} />
                </Field>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={draft.isPrimary}
                    onChange={(event) => onChange(withPrimary(drafts, draft.id, event.target.checked))}
                  />
                  <span>{t('visuals.isPrimary')}</span>
                </label>
              </div>
            )}
          </div>
        );
      })}
      <Button variant="ghost" onClick={add}>
        {t('visuals.add')}
      </Button>
    </section>
  );
}
