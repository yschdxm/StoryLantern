import { useEffect, useRef, useState } from 'react';
import type { AssembleFn } from '../../../../../plugins/writing-pipeline/src/index.ts';
import type { ScoredEntry } from '../../../../../packages/lore/src/index.ts';
import { computeUsage } from '../../../../../packages/oplog/src/index.ts';
import type { WireTransport } from '../../../../../packages/wire/src/index.ts';
import type { AppStore } from '../../app/state.ts';
import { loadWorkspace, type WorkspaceSnapshot } from '../../app/workspace.ts';
import type { ChatCall, ChatClient, ChatPreview, ChatReplyResult } from '../../data/chat-client.ts';
import { resolveCitations } from '../../data/citations.ts';
import { describeError } from '../../data/error-text.ts';
import { candidatesFor, targetLabel } from '../../data/model-routing.ts';
import { buildChatRequestV2 } from '../../data/prompt-v2.ts';
import { selectSummariesForChat } from '../../data/summary-vector-select.ts';
import { estimateTokens } from '../../data/tokens.ts';
import { SETTING_KEYS, type MessageCitation, type MessageMeta } from '../../data/types.ts';
import { createUsageStore } from '../../data/usage-store.ts';
import { useT } from '../../i18n/context.tsx';
import type { ModelAttempt, RequestTraceState } from '../RequestTracePanel.tsx';
import { buildChatOptionsV2 } from '../chat-request.ts';

export interface StreamingReply {
  text: string;
  reasoning: string;
}

/**
 * 聊天回复的完整流程（从 ChatScreen 抽出，避免它继续贴着 400 行上限）：
 * 装配上下文 → 预览请求 → 多模型回退 → 流式累积正文/思考 → 引用解析 → 落库 meta。
 *
 * 关键诚实性：
 *  - 思考链只来自 `onDelta.reasoning` / outcome.reasoning，没有就不显示；
 *  - 停止（aborted）落 `stopped`，已收到内容保留；真错误才落 `error`；
 *  - 存库正文用 `resolveCitations` 去掉引用标记后的文本，引用写进 meta。
 */
export function useChatReply(input: {
  store: AppStore;
  sessionId: string;
  chat: ChatClient;
  assemble?: AssembleFn | undefined;
  transport?: WireTransport | undefined;
  workspace: WorkspaceSnapshot | undefined;
}): {
  streaming: StreamingReply | null;
  chatError: string | undefined;
  injectedLore: ScoredEntry[];
  trace: RequestTraceState | undefined;
  runReply: () => Promise<void>;
  abort: () => void;
} {
  const { store, sessionId, chat } = input;
  const t = useT();
  const [streaming, setStreaming] = useState<StreamingReply | null>(null);
  const [chatError, setChatError] = useState<string | undefined>(undefined);
  const [injectedLore, setInjectedLore] = useState<ScoredEntry[]>([]);
  const [trace, setTrace] = useState<RequestTraceState | undefined>(undefined);
  const controllerRef = useRef<AbortController | null>(null);
  const previousBodyRef = useRef<string | undefined>(undefined);

  // 换会话：上一轮的请求体/流式/错误都不能带过去
  useEffect(() => {
    previousBodyRef.current = undefined;
    setStreaming(null);
    setChatError(undefined);
    setTrace(undefined);
    setInjectedLore([]);
  }, [sessionId]);

  const runReply = async (): Promise<void> => {
    const fresh = store.getState();
    const usage = createUsageStore({
      settings: () => store.getState().settings,
      setSetting: (key, value) => store.actions.setSetting(key, value),
    });
    const allSummaries = await store.actions.summariesOf(sessionId);
    const preselected = await selectSummariesForChat({
      onOutcome: (outcome) =>
        void store.actions.setSetting(SETTING_KEYS.vectorOutcome, JSON.stringify({ ...outcome, at: Date.now() })),
      transport: input.transport,
      ...(candidatesFor(fresh.settings, 'chat')[0]?.id === undefined
        ? {}
        : { profileId: candidatesFor(fresh.settings, 'chat')[0]?.id }),
      model: fresh.settings[SETTING_KEYS.embeddingModel],
      rerankModel: fresh.settings[SETTING_KEYS.rerankModel],
      messages: fresh.messages,
      summaries: allSummaries,
      recordUsage: async (call) => {
        await usage.record(
          fresh.settings['device.id'] ?? 'unknown',
          computeUsage({
            at: Date.now(),
            task: 'embed',
            modelId: call.modelId,
            promptTokens: call.promptTokens,
            completionTokens: 0,
            prices: usage.prices().value,
          }),
        );
      },
    });

    const activeWorkspace = input.workspace ?? (await loadWorkspace(store.repository, fresh, sessionId));
    const request = buildChatRequestV2(
      buildChatOptionsV2({
        state: fresh,
        sessionId,
        workspace: activeWorkspace,
        summaries: allSummaries,
        ...(preselected === undefined ? {} : { preselectedSummaries: preselected }),
        ...(input.assemble === undefined ? {} : { assemble: input.assemble }),
      }),
    );
    setInjectedLore(request.lore);

    const startedAt = Date.now();
    const candidates = candidatesFor(fresh.settings, 'chat');
    const attempts: ModelAttempt[] = [];
    const baseCall: ChatCall = {
      messages: request.messages,
      ...(request.systemPrompt === '' ? {} : { systemPrompt: request.systemPrompt }),
      ...(request.postHistory === undefined ? {} : { postHistory: request.postHistory }),
    };
    const firstCall: ChatCall =
      candidates[0]?.id === undefined || candidates[0].id === '' ? baseCall : { ...baseCall, profileId: candidates[0].id };

    const controller = new AbortController();
    controllerRef.current = controller;
    setChatError(undefined);
    setStreaming({ text: '', reasoning: '' });

    // 预览：先把"要发出去的"记下来（失败不阻塞发送，但面板要如实显示）
    let preview: ChatPreview | undefined;
    let previewError: string | undefined;
    try {
      preview = await chat.preview(firstCall);
    } catch (cause) {
      previewError = describeError(cause);
    }
    const previousBody = previousBodyRef.current;
    if (preview !== undefined) previousBodyRef.current = preview.body;
    setTrace({
      trace: request.trace,
      startedAt,
      attempts: [],
      inactiveCards: activeWorkspace.inactive,
      request: firstCall,
      ...(preview === undefined ? {} : { preview }),
      ...(previousBody === undefined ? {} : { previousBody }),
      ...(previewError === undefined ? {} : { previewError }),
    });

    let streamedText = '';
    let streamedReasoning = '';
    let firstDeltaAt: number | undefined;
    let promptTokens = 0;

    const metaOf = (
      outcome: ChatReplyResult,
      candidateId: string,
      candidateLabel: string,
      text: string,
      citationList: readonly MessageCitation[],
    ): MessageMeta => ({
      ...(candidateId === '' ? {} : { modelId: candidateId }),
      modelLabel: candidateLabel,
      ...(outcome.reasoning === undefined || outcome.reasoning === '' ? {} : { reasoning: outcome.reasoning }),
      ...(citationList.length === 0 ? {} : { citations: citationList }),
      tokens: {
        ...(promptTokens === 0 ? {} : { prompt: promptTokens }),
        completion: estimateTokens(text),
        estimated: true,
      },
      timing: {
        ...(firstDeltaAt === undefined ? {} : { firstDeltaMs: firstDeltaAt - startedAt }),
        totalMs: Date.now() - startedAt,
      },
    });

    try {
      if (candidates.length === 0) throw new Error(t('chat.noModel'));

      promptTokens =
        request.trace.usedTokens + estimateTokens(request.messages.map((message) => message.content).join(String.fromCharCode(10)));
      const maxOutputRaw = Number(fresh.settings[SETTING_KEYS.maxTokens] ?? '');
      const maxOutput = Number.isFinite(maxOutputRaw) && maxOutputRaw > 0 ? maxOutputRaw : 1024;
      const estimatedUsd = usage.estimateCost(candidates[0]?.id ?? '', promptTokens, maxOutput);
      const budget = usage.gate(estimatedUsd);
      if (!budget.ok) {
        throw new Error(
          t('chat.overBudget', {
            spent: budget.spentUsd.toFixed(4),
            estimate: estimatedUsd.toFixed(4),
            total: (budget.spentUsd + estimatedUsd).toFixed(4),
          }),
        );
      }

      let outcome: ChatReplyResult | undefined;
      let winner: { id: string; label: string } | undefined;
      for (const candidate of candidates) {
        setStreaming({ text: '', reasoning: '' });
        streamedText = '';
        streamedReasoning = '';
        const attemptStarted = Date.now();
        try {
          outcome = await chat.reply(
            candidate.id === '' ? baseCall : { ...baseCall, profileId: candidate.id },
            {
              signal: controller.signal,
              onDelta: (delta) => {
                if (delta.delta !== undefined && delta.delta !== '') {
                  if (firstDeltaAt === undefined) firstDeltaAt = Date.now();
                  streamedText += delta.delta;
                }
                if (delta.reasoning !== undefined && delta.reasoning !== '') {
                  if (firstDeltaAt === undefined) firstDeltaAt = Date.now();
                  streamedReasoning += delta.reasoning;
                }
                setStreaming({ text: streamedText, reasoning: streamedReasoning });
              },
            },
          );
          winner = { id: candidate.id, label: targetLabel(candidate) };
          attempts.push({ label: winner.label, ok: true, ms: Date.now() - attemptStarted });
          await usage
            .record(
              fresh.settings['device.id'] ?? 'unknown',
              computeUsage({
                at: Date.now(),
                task: 'chat',
                modelId: candidate.id === '' ? 'default' : candidate.id,
                promptTokens,
                completionTokens: estimateTokens(outcome.text),
                prices: usage.prices().value,
              }),
            )
            .catch(() => undefined);
          break;
        } catch (cause) {
          const message = describeError(cause);
          attempts.push({ label: targetLabel(candidate), ok: false, ms: Date.now() - attemptStarted, error: message });
          if (controller.signal.aborted) throw cause;
        }
      }
      setTrace((current) => (current === undefined ? current : { ...current, attempts }));

      if (outcome === undefined || winner === undefined) {
        throw new Error(attempts[attempts.length - 1]?.error ?? t('chat.noModel'));
      }

      const resolved = resolveCitations(outcome.text, request.citationWindow);
      if (resolved.text !== '') {
        await store.actions.appendMessage(
          sessionId,
          'assistant',
          resolved.text,
          outcome.aborted ? { status: 'stopped' } : {},
          undefined,
          metaOf(
            { ...outcome, reasoning: outcome.reasoning ?? streamedReasoning },
            winner.id,
            winner.label,
            resolved.text,
            resolved.citations,
          ),
        );
      }
      setTrace((current) =>
        current === undefined
          ? current
          : {
              ...current,
              ...(firstDeltaAt === undefined ? {} : { firstDeltaMs: firstDeltaAt - startedAt }),
              totalMs: Date.now() - startedAt,
            },
      );
    } catch (cause) {
      setTrace((current) => (current === undefined ? current : { ...current, attempts, totalMs: Date.now() - startedAt }));
      if (controller.signal.aborted) {
        // 用户停止：把已经收到的半截内容按 stopped 落库，不显示错误
        const resolved = resolveCitations(streamedText, request.citationWindow);
        if (resolved.text !== '') {
          await store.actions
            .appendMessage(
              sessionId,
              'assistant',
              resolved.text,
              { status: 'stopped' },
              undefined,
              {
                ...(candidates[0]?.id === undefined || candidates[0].id === ''
                  ? {}
                  : { modelId: candidates[0].id }),
                modelLabel: candidates[0] === undefined ? '—' : targetLabel(candidates[0]),
                ...(streamedReasoning === '' ? {} : { reasoning: streamedReasoning }),
                citations: resolved.citations,
                tokens: {
                  ...(promptTokens === 0 ? {} : { prompt: promptTokens }),
                  completion: estimateTokens(resolved.text),
                  estimated: true,
                },
                timing: {
                  ...(firstDeltaAt === undefined ? {} : { firstDeltaMs: firstDeltaAt - startedAt }),
                  totalMs: Date.now() - startedAt,
                },
              },
            )
            .catch(() => undefined);
        }
      } else {
        const message = describeError(cause);
        setChatError(message);
        await store.actions
          .appendMessage(sessionId, 'assistant', message, { status: 'error' })
          .catch(() => undefined);
      }
    } finally {
      controllerRef.current = null;
      setStreaming(null);
      await store.actions.loadMessages(sessionId).catch(() => undefined);
      await store.actions.refreshSessions().catch(() => undefined);
    }
  };

  return {
    streaming,
    chatError,
    injectedLore,
    trace,
    runReply,
    abort: () => controllerRef.current?.abort(),
  };
}
