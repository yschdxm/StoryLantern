import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveCard, setupOf } from '../../../packages/oplog/src/index.ts';
import { validateCard, type CharacterCard } from '../../../packages/cards/src/index.ts';
import {
  applyDraftToCard,
  cardFromLegacyCharacter,
  newCardId,
  viewOfCard,
} from '../src/data/character-compat.ts';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import type { Character } from '../src/data/types.ts';

/**
 * 过渡兼容层（ADR-0011）：旧 `Character` 形状 ↔ 角色卡。
 *
 * 重点不是"字段能映射"，而是三条容易出事的性质：
 *  1. 旧域对象映射与 `card-fallback.ts` 一致（否则提示词与列表会看到两套设定）；
 *  2. 编辑器保存只覆盖表单字段，**不抹掉** examples/state/rules/visuals 等；
 *  3. 仓储层的 `characters` 真的读写卡片，而旧字段走兼容草稿（不丢、不塞回卡里）。
 */

function legacyCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: 'legacy-1',
    name: '星野',
    description: '夜巡的守望者',
    personality: '克制、敏锐\n念旧',
    scenario: '雪线之上',
    firstMessage: '「进来吧。」',
    exampleDialogue: '',
    systemPrompt: '你只回答一句话。',
    alternateGreetings: ['第二条开场白'],
    createdAt: 1_600_000_000_000,
    updatedAt: 1_600_000_100_000,
    ...overrides,
  };
}

function completeDraft(): Parameters<typeof applyDraftToCard>[1] {
  return {
    name: '星野',
    description: '夜巡的守望者',
    background: '在雪线以北极夜中长大。',
    personalitySummary: '克制，敏锐',
    traits: ['克制', '敏锐'],
    knowledgeBoundary: '不知道山外已经换了王朝。',
    abilityBoundary: '能在暴雪里辨路，无法治愈冻伤。',
    speechStyle: '短句，少用形容词。',
    goals: ['守住隘口'],
    tags: ['夜巡'],
    rating: 'teen',
    language: 'zh-CN',
  };
}

test('cardFromLegacyCharacter：名字/背景/性格切分/systemPrompt 逐一映射', () => {
  const card = cardFromLegacyCharacter(legacyCharacter());

  assert.equal(card.card_type, 'character');
  assert.equal(card.meta.id, 'legacy-1');
  assert.equal(card.meta.name, '星野');
  assert.equal(card.meta.schema, 'rolecard/v1');
  assert.equal(card.meta.version, '1.0.0');
  assert.equal(card.meta.rating, 'general');
  assert.equal(card.meta.language, 'zh-CN');
  assert.equal(card.meta.description, '夜巡的守望者');
  assert.equal(card.identity.name, '星野');
  assert.equal(card.identity.background, '夜巡的守望者');
  assert.equal(card.persona.summary, '克制、敏锐');
  assert.deepEqual(card.persona.traits, ['克制', '敏锐', '念旧']);
  assert.equal(card.prompts?.system_extra, '你只回答一句话。');
  assert.equal(card.speech.style, '', '旧数据没有语言风格：留空、由校验器提示补全');
});

test('viewOfCard：副标题优先一句话人设，没有才退回背景截断', () => {
  const card = cardFromLegacyCharacter(legacyCharacter());
  const view = viewOfCard(card, false);
  assert.equal(view.id, 'legacy-1');
  assert.equal(view.name, '星野');
  assert.equal(view.subtitle, '克制、敏锐');
  assert.equal(view.enabled, false);

  const withoutSummary: CharacterCard = { ...card, persona: { ...card.persona, summary: '' } };
  assert.ok(viewOfCard(withoutSummary, true).subtitle.startsWith('夜巡的守望者'));
});

test('applyDraftToCard：新建得到一张校验无 error 的合法卡', () => {
  const card = applyDraftToCard(undefined, completeDraft());
  const result = validateCard(card);
  const errors = result.issues.filter((issue) => issue.severity === 'error');

  assert.deepEqual(errors, [], `不应有 error：${JSON.stringify(errors)}`);
  assert.equal(card.card_type, 'character');
  assert.ok(card.meta.id.length > 0, '新卡必须有稳定 id');
  assert.equal(card.meta.schema, 'rolecard/v1');
  assert.equal(card.meta.version, '1.0.0');
  assert.equal(card.meta.rating, 'teen');
  assert.equal(card.meta.language, 'zh-CN');
  assert.equal(card.persona.summary, '克制，敏锐');
  assert.deepEqual(card.persona.traits, ['克制', '敏锐']);
  assert.equal(card.speech.style, '短句，少用形容词。');
  assert.deepEqual(card.meta.tags, ['夜巡']);
});

test('applyDraftToCard：更新只覆盖表单字段，examples/state/rules/visuals 等全部保留', () => {
  const base = applyDraftToCard(undefined, completeDraft());
  const cover = `asset://${'a'.repeat(64)}`;
  const existing: CharacterCard = {
    ...base,
    meta: { ...base.meta, author: '原作者', license: 'CC-BY-4.0', cover },
    examples: [{ id: 'e1', tags: ['cold_start'], messages: [{ role: 'assistant', content: '「进来吧。」' }] }],
    state: {
      schema: { affection: { type: 'integer', default: 50, min: 0, max: 100 } },
      update_policy: { allow_llm_patch: true, require_engine_validation: true },
    },
    rules: [{ id: 'r1', enabled: true, priority: 1, when: { event: 'before_reply' }, actions: [{ type: 'constraint', text: '不替用户行动' }] }],
    visuals: [{ id: 'v1', type: 'portrait', path: `asset://${'b'.repeat(64)}`, caption: '黑发旧斗篷' }],
    agent: { policy: 'ask' },
    compat: { imported_from: 'sillytavern/v2', discarded_fields: ['scenario'] },
    extensions: { 'vendor.test': { keep: true } },
    presentation: { ui_panels: ['relationship'] },
    memory: { short_term_turns: 8 },
    refs: [{ target: 'scene-1', type: 'scene' }],
    brief: '作者写的简报',
  };

  const updated = applyDraftToCard(existing, {
    id: existing.meta.id,
    name: '星野·改',
    description: '新的简介',
    traits: ['冷静'],
  });

  // 表单拥有的字段被覆盖
  assert.equal(updated.meta.id, existing.meta.id);
  assert.equal(updated.meta.name, '星野·改');
  assert.equal(updated.identity.name, '星野·改');
  assert.equal(updated.meta.description, '新的简介');
  assert.deepEqual(updated.persona.traits, ['冷静']);
  // 表单没碰的字段原样保留（一次保存不能抹掉 Agent / 导入内容）
  assert.equal(updated.meta.author, '原作者');
  assert.equal(updated.meta.license, 'CC-BY-4.0');
  assert.equal(updated.meta.cover, cover);
  assert.deepEqual(updated.examples, existing.examples);
  assert.deepEqual(updated.state, existing.state);
  assert.deepEqual(updated.rules, existing.rules);
  assert.deepEqual(updated.visuals, existing.visuals);
  assert.deepEqual(updated.agent, existing.agent);
  assert.deepEqual(updated.compat, existing.compat);
  assert.deepEqual(updated.extensions, existing.extensions);
  assert.deepEqual(updated.presentation, existing.presentation);
  assert.deepEqual(updated.memory, existing.memory);
  assert.deepEqual(updated.refs, existing.refs);
  assert.equal(updated.brief, '作者写的简报');
  // 另外两个"没提供就保留"的字段
  assert.equal(updated.identity.background, existing.identity.background);
  assert.equal(updated.speech.style, existing.speech.style);
});

test('newCardId：非空且两次不同', () => {
  const first = newCardId();
  const second = newCardId();
  assert.ok(first.length > 0);
  assert.notEqual(first, second);
  assert.ok(newCardId('character').startsWith('character-'));
});

// ---------------------------------------------------------------- 仓储层（op 日志）

function makeRepo() {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  return { ports, repo: createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' }) };
}

test('仓储：characters.save 写的是角色卡，列表可见，remove 后消失', async () => {
  const { repo } = makeRepo();
  await repo.ready;

  const saved = await repo.characters.save({ name: '星野' });
  const record = liveCard(repo.currentMaterializer().state, saved.id);
  assert.ok(record !== undefined, 'card.upsert 必须落地成角色卡');
  assert.equal(record?.card.card_type, 'character');
  assert.equal(record?.card.card_type === 'character' ? record.card.identity.name : '', '星野');
  assert.deepEqual((await repo.characters.list()).map((character) => character.name), ['星野']);
  assert.equal((await repo.characters.get(saved.id))?.name, '星野');

  assert.equal(await repo.characters.remove(saved.id), true);
  assert.deepEqual(await repo.characters.list(), []);
  assert.equal(await repo.characters.remove(saved.id), false, '重复删除返回 false');
});

test('仓储：新卡建会话不写开场白，开局模式是 self', async () => {
  const { repo } = makeRepo();
  await repo.ready;

  const character = await repo.characters.save({ name: '星野' });
  const session = await repo.sessions.create(character.id);

  assert.equal(session.characterName, '星野', '会话列表要能显示卡片角色的名字');
  assert.deepEqual(await repo.messages.list(session.id), [], '卡片没有开场白，会话从空白开始');
  const setup = setupOf(repo.currentMaterializer().state, session.id);
  assert.ok(setup !== undefined, '建会话要落下开局配置');
  assert.deepEqual(setup?.setup.characters, [character.id]);
  assert.equal(setup?.setup.opening_mode, 'self', '用户先开口');
});

test('仓储：迁移后的角色被删除后，不会被旧记录兜底"复活"', async () => {
  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repo = createOpLogRepository({
    ops: ports.ops,
    settings: ports.settings,
    deviceId: 'device-a',
    loadLegacy: async () => ({
      characters: [{ id: 1, name: '旧角色', description: '来自旧表', firstMessage: '「旧开场白」' }],
      sessions: [],
      messages: [],
    }),
  });
  await repo.ready;

  const migrated = await repo.characters.list();
  assert.equal(migrated.length, 1, '旧角色迁移成卡片');
  const id = migrated[0]?.id ?? '';
  // 迁移 op 的 HLC 取自墙上时钟（t=now, c=0）；同一毫秒内的删除会按 opId 破平局而可能输。
  // 真实使用里"启动迁移"与"用户删除"隔着很久，这里等 5ms 让删除严格更新。
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await repo.characters.remove(id), true);
  assert.deepEqual(await repo.characters.list(), [], '卡片墓碑必须挡住旧记录兜底');
  assert.equal(await repo.characters.get(id), undefined);
});

test('仓储：旧字段（scenario/开场白）进兼容草稿，读回不丢、建会话按草稿插入开场白', async () => {
  const { repo } = makeRepo();
  await repo.ready;

  const character = await repo.characters.save({
    name: '星野',
    scenario: '雪线之上的隘口',
    firstMessage: '第一条',
    alternateGreetings: ['第二条'],
  });
  const read = await repo.characters.get(character.id);
  assert.equal(read?.scenario, '雪线之上的隘口', 'scenario 从兼容草稿读回');
  assert.equal(read?.firstMessage, '第一条');
  assert.deepEqual(read?.alternateGreetings, ['第二条']);

  const session = await repo.sessions.create(character.id, undefined, 1);
  assert.deepEqual((await repo.messages.list(session.id)).map((message) => message.content), ['第二条']);
  const setup = setupOf(repo.currentMaterializer().state, session.id);
  assert.equal(setup?.setup.opening_mode, 'designated');
  assert.equal(setup?.setup.opening_speaker, character.id);
  assert.equal(setup?.setup.premise, '雪线之上的隘口', '旧 scenario 成为这一局的 premise');
});
