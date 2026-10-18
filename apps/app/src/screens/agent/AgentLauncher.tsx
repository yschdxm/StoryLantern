import { useState, type ReactNode } from 'react';
import type { AppStore } from '../../app/state.ts';
import type { ChatClient } from '../../data/chat-client.ts';
import type { RequestLogPort } from '../../data/request-log.ts';
import { useT } from '../../i18n/context.tsx';
import { AgentPanel } from './AgentPanel.tsx';

/** 聊天页的 Agent 入口：只负责开关 Sheet，控制器/数据都在 AgentPanel 内。 */
export function AgentLauncher({
  store,
  chat,
  requestLog,
  settings,
  sessionId,
}: {
  store: AppStore;
  chat: ChatClient;
  requestLog: RequestLogPort | undefined;
  settings: Record<string, string>;
  sessionId: string;
}): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="chat__trace-link" onClick={() => setOpen(true)}>
        {t('agent.open')}
      </button>
      {open && (
        <AgentPanel
          store={store}
          chat={chat}
          requestLog={requestLog}
          settings={settings}
          sessionId={sessionId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
