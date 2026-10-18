import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentEventRecord, AgentProposalRecord, AgentRunRecord } from '../../../../../packages/oplog/src/index.ts';
import type { AppStore } from '../../app/state.ts';
import { createAgentController, type AgentController } from '../../data/agent-session.ts';
import type { ChatClient } from '../../data/chat-client.ts';
import { describeError } from '../../data/error-text.ts';
import type { RequestLogPort } from '../../data/request-log.ts';
import { useT } from '../../i18n/context.tsx';
import { Button, Sheet } from '../../ui/components.tsx';

type Translator = ReturnType<typeof useT>;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function clip(text: string, limit = 280): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function eventTitle(t: Translator, event: AgentEventRecord): string {
  return t(`agent.event.${event.kind}`);
}

function eventBody(t: Translator, event: AgentEventRecord): string {
  const data = recordOf(event.data);
  switch (event.kind) {
    case 'assistant': {
      const calls = Array.isArray(data['toolCalls']) ? (data['toolCalls'] as unknown[]).length : 0;
      return `${String(data['text'] ?? '')}${calls > 0 ? ` · ${t('agent.event.toolCalls', { count: calls })}` : ''}`;
    }
    case 'tool':
      return `${String(data['name'] ?? '')} ${JSON.stringify(data['arguments'] ?? {})}`;
    case 'tool_result': {
      const ok = data['ok'] === true;
      return `${String(data['name'] ?? '')} ${ok ? '✓' : '✗'} ${JSON.stringify(ok ? data['value'] : data['error'])}`;
    }
    case 'error':
      return String(data['message'] ?? JSON.stringify(data));
    case 'status': {
      if (data['phase'] === 'finished') {
        return `${String(data['status'] ?? '')} · ${t('agent.event.finished', {
          rounds: String(data['rounds'] ?? '—'),
          calls: String(data['toolCalls'] ?? '—'),
        })}`;
      }
      return JSON.stringify(data);
    }
    case 'checkpoint':
      return t('agent.event.checkpoint.body');
    default:
      return JSON.stringify(data);
  }
}

function finishedCounts(events: readonly AgentEventRecord[]): { rounds: number; calls: number } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'status') continue;
    const data = recordOf(event.data);
    if (data['phase'] !== 'finished') continue;
    return { rounds: Number(data['rounds'] ?? 0), calls: Number(data['toolCalls'] ?? 0) };
  }
  return { rounds: 0, calls: 0 };
}

/** 会话 Agent 调优面板（PLAN §7）：运行/时间线/pending 提案审批/最近 runs。 */
export function AgentPanel({
  store,
  chat,
  requestLog,
  settings,
  sessionId,
  onClose,
}: {
  store: AppStore;
  chat: ChatClient;
  requestLog: RequestLogPort | undefined;
  settings: Record<string, string>;
  sessionId: string;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const controller = useMemo((): { value?: AgentController; error?: string } => {
    try {
      return {
        value: createAgentController({ store, chat, ...(requestLog === undefined ? {} : { requestLog }), settings, sessionId }),
      };
    } catch (cause) {
      return { error: describeError(cause) };
    }
    // 面板打开期间不跟随 settings 变化重建控制器：审批应用用打开时的设置快照。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, chat, requestLog, sessionId]);

  const [goal, setGoal] = useState('');
  const [running, setRunning] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [proposals, setProposals] = useState<AgentProposalRecord[]>([]);
  const [runs, setRuns] = useState<AgentRunRecord[]>([]);
  const [events, setEvents] = useState<AgentEventRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);

  const load = async (runId?: string): Promise<void> => {
    if (controller.value === undefined) return;
    setLoading(true);
    setLoadError(undefined);
    try {
      const [nextProposals, nextRuns, nextEvents] = await Promise.all([
        controller.value.proposals('pending'),
        controller.value.listRuns(),
        controller.value.timeline(runId),
      ]);
      setProposals(nextProposals);
      setRuns(nextRuns.filter((run) => run.sessionId === undefined || run.sessionId === sessionId));
      setEvents([...nextEvents]);
    } catch (cause) {
      setLoadError(t('agent.loadFailed', { message: describeError(cause) }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(selectedRunId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (): Promise<void> => {
    const trimmed = goal.trim();
    if (trimmed === '' || controller.value === undefined) {
      setFeedback({ ok: false, text: t('agent.goalRequired') });
      return;
    }
    setRunning(true);
    setFeedback(undefined);
    try {
      const result = await controller.value.run(trimmed);
      setGoal('');
      setSelectedRunId(result.runId);
      setFeedback({
        ok: true,
        text: t('agent.result', {
          status: t(`agent.status.${result.status}`),
          rounds: result.rounds,
          calls: result.toolCalls,
        }),
      });
      await load(result.runId);
    } catch (cause) {
      setFeedback({ ok: false, text: t('agent.runFailed', { message: describeError(cause) }) });
      await load(selectedRunId);
    } finally {
      setRunning(false);
    }
  };

  const resume = async (runId: string): Promise<void> => {
    if (controller.value === undefined) return;
    setRunning(true);
    setFeedback(undefined);
    try {
      const result = await controller.value.resume(runId);
      setSelectedRunId(result.runId);
      setFeedback({
        ok: true,
        text: t('agent.result', {
          status: t(`agent.status.${result.status}`),
          rounds: result.rounds,
          calls: result.toolCalls,
        }),
      });
      await load(result.runId);
    } catch (cause) {
      setFeedback({ ok: false, text: t('agent.resumeFailed', { message: describeError(cause) }) });
      await load(runId);
    } finally {
      setRunning(false);
    }
  };

  const decide = async (proposal: AgentProposalRecord, approve: boolean): Promise<void> => {
    if (controller.value === undefined || busyId !== undefined) return;
    setBusyId(proposal.proposalId);
    setFeedback(undefined);
    try {
      if (approve) {
        const result = await controller.value.approve(proposal.proposalId);
        setFeedback({
          ok: true,
          text: `${t('agent.approve.ok', { summary: result.summary, count: result.applied })}${
            result.warnings.length === 0 ? '' : `（${result.warnings.join('；')}）`
          }`,
        });
      } else {
        await controller.value.reject(proposal.proposalId);
        setFeedback({ ok: true, text: t('agent.reject.ok') });
      }
      await load(selectedRunId);
    } catch (cause) {
      setFeedback({
        ok: false,
        text: t(approve ? 'agent.approve.failed' : 'agent.reject.failed', { message: describeError(cause) }),
      });
      await load(selectedRunId);
    } finally {
      setBusyId(undefined);
    }
  };

  const currentRun = selectedRunId === undefined ? runs[0] : runs.find((item) => item.runId === selectedRunId);
  const budget = currentRun?.budget;
  const counts = finishedCounts(events);

  return (
    <Sheet open title={t('agent.title')} onClose={onClose}>
      {controller.error !== undefined ? (
        <p className="notice notice--warn">{t('agent.unsupported', { message: controller.error })}</p>
      ) : (
        <div className="agent-panel">
          <label className="field">
            <span className="field__label">{t('agent.goal')}</span>
            <textarea
              className="textarea"
              rows={3}
              value={goal}
              placeholder={t('agent.goal.placeholder')}
              disabled={running}
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          <Button
            block
            variant={running ? 'danger' : 'primary'}
            disabled={!running && goal.trim() === ''}
            onClick={running ? () => controller.value?.cancel() : () => void run()}
          >
            {running ? t('agent.stop') : t('agent.run')}
          </Button>
          {feedback !== undefined && (
            <p className={feedback.ok ? 'notice notice--ok' : 'notice notice--warn'}>{feedback.text}</p>
          )}
          {budget !== undefined && (
            <p className="trace__meta">
              {t('agent.budget', {
                rounds: counts.rounds,
                maxRounds: budget.maxRounds,
                calls: counts.calls,
                maxCalls: budget.maxToolCalls,
              })}
            </p>
          )}
          {loadError !== undefined && (
            <div className="notice notice--warn">
              {loadError}{' '}
              <Button variant="ghost" onClick={() => void load(selectedRunId)}>
                {t('agent.retry')}
              </Button>
            </div>
          )}

          <h3 className="trace__heading">{t('agent.timeline')}</h3>
          {loading ? (
            <p className="muted">{t('agent.loading')}</p>
          ) : events.length === 0 ? (
            <p className="muted">{t('agent.timeline.empty')}</p>
          ) : (
            <ul className="trace__list">
              {events.map((event) => (
                <li key={event.eventId}>
                  <span className="trace__name">{eventTitle(t, event)}</span>
                  <span className="trace__reason">{clip(eventBody(t, event))}</span>
                </li>
              ))}
            </ul>
          )}

          <h3 className="trace__heading">{t('agent.proposals', { count: proposals.length })}</h3>
          {proposals.length === 0 ? (
            <p className="muted">{t('agent.proposals.empty')}</p>
          ) : (
            <ul className="trace__list">
              {proposals.map((proposal) => (
                <li key={proposal.proposalId}>
                  <span className="trace__name">
                    {t(`agent.kind.${proposal.kind}`)} · {proposal.summary}
                  </span>
                  <details className="agent-proposal__payload">
                    <summary>{t('agent.payload')}</summary>
                    <pre className="request-detail__pre">{JSON.stringify(proposal.payload, null, 2)}</pre>
                  </details>
                  <div className="row">
                    <Button
                      variant="ghost"
                      disabled={busyId !== undefined}
                      onClick={() => void decide(proposal, true)}
                    >
                      {busyId === proposal.proposalId ? t('agent.approving') : t('agent.approve')}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busyId !== undefined}
                      onClick={() => void decide(proposal, false)}
                    >
                      {busyId === proposal.proposalId ? t('agent.rejecting') : t('agent.reject')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h3 className="trace__heading">{t('agent.runs')}</h3>
          {runs.length === 0 ? (
            <p className="muted">{t('agent.runs.empty')}</p>
          ) : (
            <ul className="trace__list">
              {runs.map((item) => (
                <li key={item.runId}>
                  <button
                    type="button"
                    className="list-row"
                    aria-expanded={item.runId === selectedRunId}
                    onClick={() => {
                      setSelectedRunId(item.runId);
                      void load(item.runId);
                    }}
                  >
                    <span className="trace__name">
                      {t(`agent.status.${item.status}`)} · {clip(item.goal, 60)}
                    </span>
                    <span className="trace__meta">
                      {t('agent.budgetShort', {
                        rounds: item.budget.maxRounds,
                        calls: item.budget.maxToolCalls,
                      })}
                    </span>
                  </button>
                  {item.status !== 'running' && item.status !== 'done' && (
                    <Button variant="ghost" disabled={running} onClick={() => void resume(item.runId)}>
                      {running ? t('agent.resuming') : t('agent.resume')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Sheet>
  );
}
