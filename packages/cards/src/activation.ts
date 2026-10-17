/**
 * 卡片激活（"哪张卡参与这一局的上下文"）。
 *
 * 结论先说：**不做"全局注册 / 会话注册"两份手工名单**，而是三层：
 *
 *  1. **库级启停**（`libraryEnabled`）：这张卡退役/草稿 → 任何会话都不参与。
 *     同步、但不写进卡片内容：导出/分享卡片时不该带走别人的停用状态。
 *  2. **资源池**（`SessionSetup.mounts`）：这一局加载了哪些世界包/单卡。
 *     不填 = 全库可用（只有一个库的轻量用法）。
 *  3. **按类型自动激活**：角色看是否在场、场景看当前舞台、物品看实例是否存在、
 *     典籍看是否在池内（再交给关键词扫描）。用户要手动干预时用 `SessionSetup.overrides`
 *     只记**例外**（这张关掉 / 这张强制打开），不维护全量清单。
 *
 * 为什么这样比"注册表"好：
 *  - 手工清单会腐烂：新建一个场景/物品、进一个新会话，忘了挂就静默失效；
 *  - 每类资源的本性不同（设计文档 §1.1）：典籍是被动知识、场景是舞台、物品有实例——
 *    用同一张"已注册"表表达它们，等于把酒馆"一种形状装所有东西"的错误换个地方重犯；
 *  - 这里每张卡都返回**可读原因**（`code`），请求面板能说清"它为什么没参与"。
 */

import type { CardType } from './types-base.ts';
import type { CardDocument } from './types-document.ts';
import type { SessionRuntime, SessionSetup } from './types-session.ts';

export type ActivationCode =
  | 'library-disabled'
  | 'card-disabled'
  | 'override-off'
  | 'override-on'
  | 'member'
  | 'current-scene'
  | 'held-item'
  | 'mounted'
  | 'not-mounted'
  | 'not-in-session'
  | 'no-instance'
  | 'unknown';

export interface Activation {
  active: boolean;
  code: ActivationCode;
}

export interface ActivationEntry {
  id: string;
  kind: CardType;
  code: ActivationCode;
}

export interface ActivationInput {
  setup: SessionSetup;
  runtime: SessionRuntime;
  /** 库级启停（缺省 = 启用）。`false` 表示这张卡退役/草稿。 */
  libraryEnabled?: boolean;
  /** 资源池（卡片 id 集合）；`undefined` = 全库可用。 */
  mounted?: ReadonlySet<string>;
}

/** 卡片是否在资源池里（没设池 = 全库都在池里）。 */
export function inPool(cardId: string, mounted: ReadonlySet<string> | undefined): boolean {
  return mounted === undefined || mounted.has(cardId);
}

function overrideOf(setup: SessionSetup, cardId: string): boolean | undefined {
  return setup.overrides?.[cardId];
}

/** 单张卡的激活判定（纯函数、确定性）。 */
export function resolveActivation(card: CardDocument, input: ActivationInput): Activation {
  const id = card.meta.id;
  if (input.libraryEnabled === false) return { active: false, code: 'library-disabled' };
  const override = overrideOf(input.setup, id);
  if (override === false) return { active: false, code: 'override-off' };
  if (override === true) return { active: true, code: 'override-on' };

  switch (card.card_type) {
    case 'character':
      return input.setup.characters.includes(id)
        ? { active: true, code: 'member' }
        : { active: false, code: 'not-in-session' };
    case 'scene':
      return input.runtime.current_scene_id === id
        ? { active: true, code: 'current-scene' }
        : { active: false, code: 'not-in-session' };
    case 'item': {
      const holders = new Set(input.setup.characters);
      if (input.runtime.current_scene_id !== undefined) holders.add(input.runtime.current_scene_id);
      const instances = Object.values(input.runtime.items);
      return instances.some((instance) => instance.item_id === id && holders.has(instance.holder))
        ? { active: true, code: 'held-item' }
        : { active: false, code: 'no-instance' };
    }
    case 'lore':
      // 条目级启停（作者语义，跟着卡片走）优先于资源池：关掉就是不参与任意会话
      if (card.enabled === false) return { active: false, code: 'card-disabled' };
      // 关键词命中与条件在扫描/求值阶段算；这里只回答"它有没有资格被扫到"
      return inPool(id, input.mounted)
        ? { active: true, code: 'mounted' }
        : { active: false, code: 'not-mounted' };
    default:
      // 未知类型（下一版 event/faction）：不因为本实现不认识就把它丢掉
      return { active: true, code: 'unknown' };
  }
}

/** 把一批卡片分成"参与 / 不参与"，并保留不参与的原因（给请求面板）。 */
export function partitionCards(
  cards: readonly CardDocument[],
  input: Omit<ActivationInput, 'card' | 'libraryEnabled'> & {
    isLibraryEnabled?: (cardId: string) => boolean;
  },
): { active: CardDocument[]; inactive: ActivationEntry[] } {
  const active: CardDocument[] = [];
  const inactive: ActivationEntry[] = [];
  for (const card of cards) {
    const enabled = input.isLibraryEnabled === undefined ? undefined : input.isLibraryEnabled(card.meta.id);
    const verdict = resolveActivation(card, {
      setup: input.setup,
      runtime: input.runtime,
      ...(enabled === undefined ? {} : { libraryEnabled: enabled }),
      ...(input.mounted === undefined ? {} : { mounted: input.mounted }),
    });
    if (verdict.active) active.push(card);
    else inactive.push({ id: card.meta.id, kind: card.card_type, code: verdict.code });
  }
  return { active, inactive };
}
