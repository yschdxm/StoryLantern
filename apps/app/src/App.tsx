import type { AppViewModel } from './view-model.ts';

export interface AppProps {
  viewModel: AppViewModel;
  onChangeLocale(locale: string): void;
}

/**
 * 界面：一屏同时展示"聊天"与"这次请求是怎么拼出来的"。
 *
 * M0 的目标不是好看，而是**把可解释性摆到台面上**：每个上下文块是否纳入、占多少 token、
 * 为什么被裁掉，以及整份文案随语言切换。真正的设计系统在 M3 落地。
 */
export function App({ viewModel, onChangeLocale }: AppProps) {
  return (
    <main className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">{viewModel.title}</h1>
          <p className="app__tagline">{viewModel.tagline}</p>
        </div>
        <div className="app__controls">
          <span className="badge badge--ok">{viewModel.syncStatus}</span>
          <label className="field">
            <span className="field__label">语言 / Language</span>
            <select
              className="field__control"
              value={viewModel.locale}
              onChange={(event) => onChangeLocale(event.target.value)}
            >
              {viewModel.localeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="grid">
        <section className="panel" aria-label={viewModel.title}>
          <h2 className="panel__title">{viewModel.pluginsSummary}</h2>
          <ul className="chips">
            {viewModel.plugins.map((plugin) => (
              <li key={plugin.id} className={`chip chip--${plugin.status}`}>
                {plugin.id}
                <small>{plugin.status}</small>
              </li>
            ))}
          </ul>

          <h2 className="panel__title">Chat</h2>
          <ol className="chat">
            {viewModel.chat.map((row) => (
              <li key={row.id} className={`chat__row chat__row--${row.author}`}>
                <span className="chat__author">{row.roleLabel}</span>
                <span className="chat__text">{row.text}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel" aria-label={viewModel.graphTitle}>
          <h2 className="panel__title">{viewModel.graphTitle}</h2>
          <p className="panel__meta">{viewModel.budgetSummary}</p>
          <ul className="graph">
            {viewModel.graph.map((node) => (
              <li key={node.id} className={`graph__node graph__node--${node.included ? 'in' : 'out'}`}>
                <div className="graph__head">
                  <code>{node.id}</code>
                  <span className="graph__tokens">{node.tokens} t</span>
                  <span className={`badge ${node.included ? 'badge--ok' : 'badge--warn'}`}>{node.includedLabel}</span>
                </div>
                <p className="graph__reason">{node.reason}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
