import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpeningPrompt,
  composeSessionSetup,
  generateOpening,
  loadSessionCreateResources,
  OPENING_INSTRUCTION,
  OPENING_TRIGGER,
  openingCardsFor,
  previewOpeningCards,
  previewOpeningRuntime,
  type OpeningRequestInput,
} from '../src/data/auto-opening.ts';
import type { ChatCall, ChatClient, ChatReplyResult } from '../src/data/chat-client.ts';
import type { Repository } from '../src/data/repository.ts';
import { buildChatRequestV2 } from '../src/data/prompt-v2.ts';
import { SETTING_KEYS, type Character } from '../src/data/types.ts';
import type {
  CardMeta,
  CharacterCard,
  ItemCard,
  LoreCard,
  SceneCard,
  SessionRuntime,
  SessionSetup,
} from '../../../packages/cards/src/index.ts';

/** 智能开场：指令/装配、成功、空输出、抛错、超时、确定性、资源池筛选。 */

const meta = (patch: Partial<CardMeta> = {}): CardMeta => ({
  id: 'c1', schema: 'rolecard/v1', name: '林霜', version: '1.0.0',
  language: 'zh-CN', description: '', rating: 'general', ...patch,
});
const characterCard = (patch: Partial<CharacterCard> = {}): CharacterCard => ({
  card_type: 'character', meta: meta(),
  identity: { name: '林霜', background: '北境出身。' },
  persona: { summary: '冷面女剑士', traits: [], knowledge_boundary: '', ability_boundary: '' },
  speech: { style: '' }, ...patch,
});
const sceneCard = (patch: Partial<SceneCard> = {}): SceneCard => ({
  card_type: 'scene', meta: meta({ id: 's1', schema: 'scene/v1', name: '边境酒馆' }),
  type: 'physical', description: '', appearance: { summary: '雨夜的酒馆。' }, ...patch,
});
const itemCard = (patch: Partial<ItemCard> = {}): ItemCard => ({
  card_type: 'item', meta: meta({ id: 'i1', schema: 'item/v1', name: '月光剑' }),
  type: 'weapon', description: '', function: '', ...patch,
});
const loreCard = (patch: Partial<LoreCard> = {}): LoreCard => ({
  card_type: 'lore', meta: meta({ id: 'l1', schema: 'lore/v1', name: '银月战争' }),
  kind: 'history', content: '银月战争发生在三百年前。', keys: ['银月'], ...patch,
});

const setupOf = (patch: Partial<SessionSetup> = {}): SessionSetup => ({
  characters: ['c1'], premise: '雨夜投宿。', opening_mode: 'designated', origin: 'user', ...patch,
});
const legacyCharacter = (id = 'old1', name = '旧角色'): Character => ({
  id, name, description: '', personality: '', scenario: '', firstMessage: '', exampleDialogue: '',
  systemPrompt: '', alternateGreetings: [], createdAt: 1, updatedAt: 1,
});
const runtimeOf = (patch: Partial<SessionRuntime> = {}): SessionRuntime => ({
  variables: { session: {} }, items: {}, scene_state: {}, ...patch,
});
const inputOf = (patch: Partial<OpeningRequestInput> = {}): OpeningRequestInput => ({
  settings: {},
  sessionTitle: '隘口之夜',
  setup: setupOf(),
  cards: [characterCard(), sceneCard(), loreCard()],
  runtime: runtimeOf({ current_scene_id: 's1' }),
  ...patch,
});

interface MockChat extends ChatClient {
  calls: ChatCall[];
}

function mockChat(options: { text?: string; fail?: unknown; hang?: boolean; available?: boolean } = {}): MockChat {
  const calls: ChatCall[] = [];
  const client: MockChat = {
    calls,
    available: options.available ?? true,
    async reply(request, handlers) {
      calls.push(request);
      if (options.hang === true) {
        return new Promise<ChatReplyResult>((_resolve, reject) => {
          handlers.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      if (options.fail !== undefined) throw options.fail;
      return { text: options.text ?? '', aborted: false };
    },
    async probe() {
      return { ok: true, message: '' };
    },
    async preview() {
      return { url: '', body: '', byteLength: 0, model: '' };
    },
  };
  return client;
}

test('buildOpeningPrompt：固定指令在系统提示最前、cite=false、空历史、成员/处境/场景都在', () => {
  const options = buildOpeningPrompt(inputOf({ settings: { [SETTING_KEYS.systemPrompt]: '用短句。' } }));
  assert.equal(options.cite, false);
  assert.deepEqual(options.history, [], '历史固定为空（由 generateOpening 只追加一条触发消息）');
  assert.equal(options.sessionTitle, '隘口之夜');

  const request = buildChatRequestV2(options);
  assert.ok(request.systemPrompt.startsWith(OPENING_INSTRUCTION), '开场指令必须排在最前');
  assert.match(request.systemPrompt, /用短句。/, '设置里的自定义提示不能丢');
  assert.match(request.systemPrompt, /你要扮演「林霜」/);
  assert.match(request.systemPrompt, /【本局处境】雨夜投宿。/);
  assert.match(request.systemPrompt, /【当前场景】边境酒馆/);
  assert.match(OPENING_INSTRUCTION, /2–4 句/);
  assert.match(OPENING_INSTRUCTION, /不超过 200 字/);
  assert.deepEqual(request.messages, []);
});

test('确定性：同输入两次装配得到同一个系统提示与同一份块', () => {
  const first = buildChatRequestV2(buildOpeningPrompt(inputOf()));
  const second = buildChatRequestV2(buildOpeningPrompt(inputOf()));
  assert.equal(first.systemPrompt, second.systemPrompt);
  assert.deepEqual(first.trace.blocks, second.trace.blocks);
});

test('generateOpening：成功返回 trim 后的文本，只发触发消息且带系统提示', async () => {
  const chat = mockChat({ text: '  雨声压低了酒馆的喧闹。  ' });
  const result = await generateOpening({ ...inputOf(), chat });
  assert.deepEqual(result, { ok: true, text: '雨声压低了酒馆的喧闹。' });
  assert.equal(chat.calls.length, 1);
  assert.deepEqual(chat.calls[0]?.messages, [{ role: 'user', content: OPENING_TRIGGER }]);
  assert.match(chat.calls[0]?.systemPrompt ?? '', /现在只输出这一局的开场/);
});

test('generateOpening：按任务选第一个模型配置（与聊天页一致）', async () => {
  const settings = {
    [SETTING_KEYS.modelProfiles]: JSON.stringify([
      { id: 'p1', name: '大模型', baseUrl: 'https://example.invalid', model: 'm', tasks: ['chat'], maxTokens: 512, enabled: true },
    ]),
  };
  const chat = mockChat({ text: '好。' });
  const result = await generateOpening({ ...inputOf({ settings }), chat });
  assert.equal(result.ok, true);
  assert.equal(chat.calls[0]?.profileId, 'p1');
});

test('generateOpening：空输出 → ok:false 且有可读原因（不假装成功）', async () => {
  const result = await generateOpening({ ...inputOf(), chat: mockChat({ text: '   ' }) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /空内容/);
});

test('generateOpening：模型抛错 → ok:false 且原因可读', async () => {
  const result = await generateOpening({ ...inputOf(), chat: mockChat({ fail: new Error('网络不可用') }) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /网络不可用/);
});

test('generateOpening：超时 → 中止请求并返回超时原因', async () => {
  const startedAt = Date.now();
  const result = await generateOpening({ ...inputOf(), chat: mockChat({ hang: true }), timeoutMs: 10 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /超时/);
  assert.ok(Date.now() - startedAt < 1000, '不能真的等 15 秒');
});

test('generateOpening：客户端不可用 → 直接给出可读原因', async () => {
  const result = await generateOpening({ ...inputOf(), chat: mockChat({ available: false }) });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /不能调用模型/);
});

test('previewOpeningCards / openingCardsFor：按成员、当前场景、资源池、库启停筛选', () => {
  const cards = [
    characterCard(),
    characterCard({ meta: meta({ id: 'c2', name: '老王' }), identity: { name: '老王', background: '' } }),
    sceneCard(),
    sceneCard({ meta: meta({ id: 's2', schema: 'scene/v1', name: '北门' }), type: 'physical', description: '' }),
    itemCard(),
    loreCard(),
    loreCard({ meta: meta({ id: 'l2', schema: 'lore/v1', name: '未挂载典籍' }) }),
    loreCard({ meta: meta({ id: 'l3', schema: 'lore/v1', name: '停用典籍' }) }),
  ];
  const setup = setupOf({ scene_id: 's1', mounts: { card_ids: ['l1', 'l3'] } });
  const active = previewOpeningCards({
    cards,
    setup,
    library: [{ id: 'l3', enabled: false }],
  }).map((card) => card.meta.id);
  assert.deepEqual(active.sort(), ['c1', 'l1', 's1'], '成员 + 当前场景 + 池内且启用的典籍');
  assert.ok(!active.includes('c2'), '非成员不参与');
  assert.ok(!active.includes('i1'), '没有实例的物品不参与');
  assert.ok(!active.includes('l2'), '不在资源池里的典籍不参与');
  assert.ok(!active.includes('l3'), '库级停用的卡不参与');

  const legacy = openingCardsFor({ cards: [], legacyCharacters: [legacyCharacter()], setup });
  assert.deepEqual(legacy.map((card) => card.meta.id), ['old1']);
});

test('previewOpeningRuntime：当前场景来自 setup.scene_id（与 deriveRuntime 首个场景一致）', () => {
  assert.equal(previewOpeningRuntime(setupOf({ scene_id: 's1' })).current_scene_id, 's1');
  assert.equal(previewOpeningRuntime(setupOf()).current_scene_id, undefined);
});

test('composeSessionSetup：designated 带开口者与文本，self 不写开场字段，都做 trim', () => {
  const form = {
    characters: ['c1'], packIds: ['p1'], cardIds: [], sceneId: 's1',
    premise: ' 雨夜投宿。 ', userRole: ' 旅人 ', setting: '', tone: 'dark' as const,
  };
  const designated = composeSessionSetup(form, { mode: 'designated', speaker: 'c1', text: ' 进来吧。 ' });
  assert.equal(designated.opening_mode, 'designated');
  assert.equal(designated.opening_speaker, 'c1');
  assert.equal(designated.opening_input, '进来吧。');
  assert.equal(designated.premise, '雨夜投宿。');
  assert.deepEqual(designated.mounts, { pack_ids: ['p1'] });
  assert.equal(designated.setting, undefined);
  assert.equal(designated.tone, 'dark');

  const self = composeSessionSetup(form, { mode: 'self', text: '不该写入' });
  assert.equal(self.opening_mode, 'self');
  assert.equal(self.opening_input, undefined);
  assert.equal(self.opening_speaker, undefined);
});

test('loadSessionCreateResources：没有卡片仓储时返回 undefined；有则一次读齐三样', async () => {
  assert.equal(await loadSessionCreateResources({} as Repository), undefined);
  const repository = {
    cards: {
      list: async () => [characterCard()],
      library: async () => [{ id: 'c1', enabled: true }],
    },
    packs: { list: async () => [{ id: 'p1', name: '包', schema: 'worldpack/v1', version: '1.0.0', language: 'zh-CN', card_ids: ['c1'] }] },
  } as unknown as Repository;
  const loaded = await loadSessionCreateResources(repository);
  assert.deepEqual(loaded?.cards.map((card) => card.meta.id), ['c1']);
  assert.deepEqual(loaded?.packs.map((pack) => pack.id), ['p1']);
  assert.deepEqual(loaded?.library, [{ id: 'c1', enabled: true }]);
});
