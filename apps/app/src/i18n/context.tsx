import { createContext, useContext, type ReactNode } from 'react';
import type { Translator } from './locale.ts';

/** React 侧的翻译上下文；由 main.tsx 用当前语言的 t 提供。 */
const I18nContext = createContext<Translator>((key) => key);

export function I18nProvider({ t, children }: { t: Translator; children: ReactNode }): ReactNode {
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

export function useT(): Translator {
  return useContext(I18nContext);
}
