import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importText, type ImportedCharacter, type ImportedLorebookFile } from '../../../packages/importer/src/index.ts';
import { validateCard } from '../../../packages/cards/src/index.ts';
import { createLocalOpPorts } from '../src/data/op-ports.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import { createOpLogRepository } from '../src/data/op-repository.ts';
import { planCharacterImport, planLorebookImport } from '../src/data/import-cards.ts';
import { exportCharacterCard, exportLorebook } from '../src/data/export-cards.ts';

/**
 * 酒馆 → 卡片模型 → 酒馆的映射契约。
 *
 * 钉住三件事：**映射正确**（卡片/草稿/世界包各就各位）、**不静默丢数据**
 *（丢弃字段进 discarded + notes）、**可往返**（导入 → 导出 → 再导入拿得回成品文本）。
 */

const NOW = 1_700_000_000_000;

/** 一张典型 CCv2 卡（含内嵌世界书、开场白、scenario、extensions、depth_prompt）。 */
const V2_JSON = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '星野',
    description: '夜巡的守望者，话不多但记得每一个名字。',
    personality: '克制、敏锐、对旧物有执念。',
    scenario: '雪线之上的隘口，灯火将尽。',
    first_mes: '「进来吧，风会替你关门。」',
    mes_example: '<START>\n{{user}}: 你守了多久？\n{{char}}: 久到忘了数。',
    creator_notes: '夹具样本：内容为占位文本。',
    system_prompt: '你以克制的笔触叙事。',
    post_history_instructions: '保持语气一致。',
    alternate_greetings: ['「灯还亮着，你就还没走错路。」'],
    tags: ['fixture', 'fantasy'],
    creator: 'storylantern-fixtures',
    character_version: '1.0',
    depth_prompt: '深处的一句提示。',
    extensions: { 'fixture/note': { generated: true } },
    character_book: {
      name: '星野的设定',
      description: '卡片内嵌世界书',
      entries: [
        {
          keys: ['铜铃'],
          secondary_keys: ['遗物'],
          content: '铜铃有一道细缝，是三年前的冬天留下的。',
          enabled: true,
          insertion_order: 10,
          comment: '随身物',
          constant: false,
        },
        {
          keys: ['雪线'],
          content: '雪线以上没有名字，只有风。',
          enabled: false,
          insertion_order: 20,
          comment: '地理',
          constant: true,
        },
      ],
    },
  },
});

function typical(): ImportedCharacter {
  return importText('card-v2.json', V2_JSON) as ImportedCharacter;
}

/** 手工构造最小输入：只测 examples 解析时用，避免被其它字段干扰。 */
function character(overrides: Partial<ImportedCharacter> = {}): ImportedCharacter {
  return {
    kind: 'character',
    source: 'x.json',
    name: '星野',
    description: '',
    personality: '克制',
    scenario: '',
    firstMessage: '',
    exampleDialogue: '',
    spec: 'chara_card_v2',
    notes: [],
    ...overrides,
    systemPrompt: overrides.systemPrompt ?? '',
    alternateGreetings: overrides.alternateGreetings ?? [],
  };
}

test('导入：典型 CCv2 卡 → 卡片字段、两条草稿、内嵌世界包的典籍卡与包', () => {
  const plan = planCharacterImport(typical(), { now: NOW, id: 'card-1' });
  const card = plan.card;

  assert.equal(card.meta.id, 'card-1');
  assert.equal(card.meta.schema, 'rolecard/v1');
  assert.equal(card.meta.name, '星野');
  assert.equal(card.meta.description, '夹具样本：内容为占位文本。', 'meta.description 优先 creator_notes');
  assert.equal(card.meta.version, '1.0');
  assert.equal(card.meta.language, 'zh-CN');
  assert.equal(card.meta.rating, 'general');
  assert.deepEqual([...(card.meta.tags ?? [])], ['fixture', 'fantasy']);
  assert.equal(card.meta.author, 'storylantern-fixtures');

  assert.equal(card.identity.name, '星野');
  assert.equal(card.identity.background, '夜巡的守望者，话不多但记得每一个名字。');
  assert.equal(card.persona.summary, '克制、敏锐、对旧物有执念。');
  assert.deepEqual([...card.persona.traits], ['克制', '敏锐', '对旧物有执念。']);
  assert.equal(card.persona.knowledge_boundary, '', '酒馆没有的字段留空，不编');
  assert.equal(card.speech.style, '');
  assert.equal(card.prompts?.system_extra, '你以克制的笔触叙事。');
  assert.equal(card.prompts?.post_history_instructions, '保持语气一致。');
  assert.equal(card.compat?.imported_from, 'sillytavern/v2');
  assert.equal(card.compat?.imported_at, NOW);

  // mes_example：<START> 被剔除，role 前缀解析成多轮
  assert.equal(card.examples?.length, 1);
  assert.equal(card.examples?.[0]?.id, 'card-1-example-1');
  assert.deepEqual(card.examples?.[0]?.messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(card.examples?.[0]?.messages[1]?.content, '久到忘了数。');

  // 成品文本进草稿，不进卡片
  assert.deepEqual(plan.stash.map((entry) => entry.id), ['stash-scenario-card-1', 'stash-opening-card-1']);
  assert.equal(plan.stash[0]?.kind, 'scenario');
  assert.equal(plan.stash[0]?.text, '雪线之上的隘口，灯火将尽。');
  assert.equal(plan.stash[0]?.created_at, NOW);
  assert.equal(
    plan.stash[1]?.text,
    '「进来吧，风会替你关门。」\n\n---\n\n「灯还亮着，你就还没走错路。」',
    '主开场白在前、备选在后，用与迁移相同的分隔符',
  );

  // 丢弃清单：extensions 的键 + depth_prompt（没有承载）
  assert.deepEqual([...(card.compat?.discarded_fields ?? [])], ['fixture/note', 'depth_prompt']);
  assert.deepEqual(plan.discarded, ['fixture/note', 'depth_prompt']);
  assert.ok(plan.notes.some((note) => note.includes('scenario 已转存')), '转存要提示');
  assert.ok(plan.notes.some((note) => note.includes('开场白 2 条')));
  assert.ok(plan.notes.some((note) => note.includes('已丢弃字段')), '丢弃清单要可见');
  assert.ok(plan.notes.some((note) => note.includes('knowledge_boundary')), 'Agent 可补全的字段要提示');

  // 内嵌世界书 → 1 包 + 2 典籍卡；包名固定 <角色名> 的世界书
  assert.equal(plan.loreCards.length, 2);
  assert.equal(plan.pack?.name, '星野 的世界书');
  assert.equal(plan.pack?.schema, 'worldpack/v1');
  assert.deepEqual([...(plan.pack?.card_ids ?? [])], plan.loreCards.map((lore) => lore.meta.id));
  const first = plan.loreCards[0];
  assert.ok(first !== undefined);
  assert.equal(first.card_type, 'lore');
  assert.equal(first.meta.name, '随身物', 'name 优先 comment');
  assert.equal(first.content, '铜铃有一道细缝，是三年前的冬天留下的。');
  assert.deepEqual([...first.keys], ['铜铃']);
  assert.deepEqual([...(first.secondary_keys ?? [])], ['遗物']);
  assert.equal(first.trigger?.priority, 10, 'insertion_order → trigger.priority');
  assert.equal('depth' in (first.trigger ?? {}), false, 'depth 缺省 = 默认窗口，不写 0');
  assert.deepEqual([...(first.refs ?? [])], [{ target: 'card-1', type: 'related' }], 'refs 指向角色 id');

  // 关闭的条目照常导入；条目级启停落在 LoreCard.enabled，不用 tags 假装
  const second = plan.loreCards[1];
  assert.ok(second !== undefined);
  assert.equal(second.enabled, false, '条目级启停映射到 LoreCard.enabled');
  assert.equal(second.meta.tags, undefined, '不用 tags 假装 enabled');
  assert.ok(plan.notes.some((note) => note.includes('关闭')), '关闭条目要提示');
});

test('导入：mes_example 三种形态（全带前缀 / 全不带 / 混合）', () => {
  const structured = planCharacterImport(character({ exampleDialogue: '{{user}}: 你好\n{{char}}: 你也好' }), { now: NOW });
  assert.deepEqual(
    structured.card.examples?.[0]?.messages.map((message) => `${message.role}:${message.content}`),
    ['user:你好', 'assistant:你也好'],
  );
  assert.equal(structured.stash.some((entry) => entry.kind === 'other'), false, '结构可靠时不额外存草稿');

  const plain = planCharacterImport(character({ exampleDialogue: '第一行\n第二行' }), { now: NOW });
  assert.deepEqual(
    plain.card.examples?.[0]?.messages.map((message) => `${message.role}:${message.content}`),
    ['assistant:第一行', 'assistant:第二行'],
    '没有角色前缀时不猜说话人，全部按 assistant',
  );
  assert.equal(plain.stash.some((entry) => entry.kind === 'other'), false);

  const mixedText = '{{user}}: 你好\n没有前缀的一行';
  const mixed = planCharacterImport(character({ exampleDialogue: mixedText }), { now: NOW });
  assert.deepEqual(
    mixed.card.examples?.[0]?.messages.map((message) => message.role),
    ['assistant', 'assistant'],
    '混合形态不猜结构',
  );
  const raw = mixed.stash.find((entry) => entry.kind === 'other');
  assert.equal(raw?.text, mixedText, '原文进 stash，不丢数据');
  assert.ok(mixed.notes.some((note) => note.includes('mes_example')));
});

test('导出往返：卡片 + 草稿 → 酒馆 v2，能拿回 name/description/scenario/first_mes', () => {
  const plan = planCharacterImport(typical(), { now: NOW, id: 'card-1' });
  const exported = exportCharacterCard(plan.card, plan.stash);
  const payload = JSON.parse(exported.json) as { spec: string; data: Record<string, unknown> };
  assert.equal(payload.spec, 'chara_card_v2');
  assert.equal(payload.data['name'], '星野');
  assert.equal(payload.data['description'], '夜巡的守望者，话不多但记得每一个名字。');
  assert.equal(payload.data['scenario'], '雪线之上的隘口，灯火将尽。');
  assert.equal(payload.data['first_mes'], '「进来吧，风会替你关门。」');
  assert.deepEqual(payload.data['alternate_greetings'], ['「灯还亮着，你就还没走错路。」']);
  assert.equal(payload.data['creator_notes'], '夹具样本：内容为占位文本。');
  assert.equal(payload.data['system_prompt'], '你以克制的笔触叙事。');
  assert.equal(payload.data['post_history_instructions'], '保持语气一致。');
  assert.equal(payload.data['mes_example'], '{{user}}: 你守了多久？\n{{char}}: 久到忘了数。');
  assert.equal(payload.data['character_version'], '1.0');
  assert.equal(payload.data['creator'], 'storylantern-fixtures');

  // 导入出来的卡还没补全我们的专属字段：这一步没有可丢的，losses 应为空
  assert.deepEqual(exported.losses, []);

  // 补上我们的专属字段后再导出：无法映射的要逐条列出（不能假装无损）
  const rich = {
    ...plan.card,
    persona: { ...plan.card.persona, knowledge_boundary: '不知道王都的事', ability_boundary: '不会魔法' },
    speech: { style: '简短' },
    state: {
      schema: { affection: { type: 'integer' as const, default: 0 } },
      update_policy: { allow_llm_patch: true, require_engine_validation: true },
    },
  };
  const richExport = exportCharacterCard(rich, plan.stash);
  assert.ok(richExport.losses.includes('persona.knowledge_boundary'));
  assert.ok(richExport.losses.includes('persona.ability_boundary'));
  assert.ok(richExport.losses.includes('speech.style'));
  assert.ok(richExport.losses.includes('state'));

  // 再导入一次：成品文本从拆开的 v2 字段回到草稿
  const again = planCharacterImport(importText('again.json', exported.json) as ImportedCharacter, { now: NOW });
  assert.equal(again.card.identity.name, '星野');
  assert.equal(again.card.identity.background, '夜巡的守望者，话不多但记得每一个名字。');
  assert.equal(again.stash.find((entry) => entry.kind === 'scenario')?.text, '雪线之上的隘口，灯火将尽。');
  assert.equal(
    again.stash.find((entry) => entry.kind === 'opening')?.text,
    '「进来吧，风会替你关门。」\n\n---\n\n「灯还亮着，你就还没走错路。」',
  );
});

test('导入：独立世界书 → 包 + 典籍卡（含关闭条目与 order/depth/recursive）', () => {
  const file = importText(
    'world.json',
    JSON.stringify({
      entries: {
        '0': {
          key: ['灯'],
          keysecondary: ['夜'],
          comment: '条目 0',
          content: '灯是这条路上唯一不会说谎的东西。',
          constant: false,
          disable: false,
          order: 100,
          depth: 4,
          excludeRecursion: true,
        },
        '1': {
          key: ['铜铃'],
          comment: '条目 1',
          content: '铜铃响的时候，别回头。',
          constant: false,
          disable: true,
          order: 120,
        },
      },
    }),
  ) as ImportedLorebookFile;
  const plan = planLorebookImport(file.lorebook, { now: NOW, id: 'book-1' });

  assert.equal(plan.pack.id, 'book-1');
  assert.equal(plan.pack.name, 'world'); // importText 用文件名兜底
  assert.equal(plan.pack.description, '');
  assert.equal(plan.pack.version, '1.0.0');
  assert.equal(plan.pack.language, 'zh-CN');
  assert.equal(plan.cards.length, 2);
  assert.deepEqual([...plan.pack.card_ids], ['book-1-lore-1', 'book-1-lore-2']);

  const first = plan.cards[0];
  assert.ok(first !== undefined);
  assert.equal(first.trigger?.priority, 100);
  assert.equal(first.trigger?.depth, 4);
  assert.equal(first.trigger?.recursive, false, 'excludeRecursion=true → recursive=false');
  assert.deepEqual([...(first.secondary_keys ?? [])], ['夜']);

  const disabled = plan.cards[1];
  assert.ok(disabled !== undefined);
  assert.equal(disabled.enabled, false, 'disable=true → enabled:false');
  assert.ok(plan.notes.some((note) => note.includes('关闭')));
});

test('导出世界书：ST 原生 entries（含禁用条目）+ 无法映射字段清单', () => {
  const plan = planLorebookImport(
    {
      name: '边境城',
      description: '设定集',
      entries: [
        { keys: ['铜铃'], secondaryKeys: ['遗物'], content: '铜铃是遗物。', name: '遗物', enabled: true, constant: false, order: 10 },
        { keys: ['禁地'], secondaryKeys: [], content: '禁地不许提。', name: '禁地', enabled: false, constant: false, order: 20 },
      ],
    },
    { now: NOW, id: 'book-1' },
  );
  const exported = exportLorebook(plan.pack, plan.cards);
  const payload = JSON.parse(exported.json) as { name: string; entries: Record<string, Record<string, unknown>> };
  assert.equal(payload.name, '边境城');
  const entry = payload.entries['0'];
  assert.ok(entry !== undefined);
  assert.deepEqual(entry['key'], ['铜铃']);
  assert.deepEqual(entry['keysecondary'], ['遗物']);
  assert.equal(entry['comment'], '遗物');
  assert.equal(entry['content'], '铜铃是遗物。');
  assert.equal(entry['constant'], false);
  assert.equal(entry['order'], 10);
  assert.equal(entry['depth'], 0);
  assert.equal(entry['disable'], false);
  assert.equal(payload.entries['1']?.['disable'], true, '条目级启停要能往返');
  assert.ok(exported.losses.includes('lore.meta.id'), '卡片 id 不能往返，要提示');
});

test('落库：导入计划能直接过校验并写进卡片仓储（过渡态字段只 warning）', async () => {
  const plan = planCharacterImport(typical(), { now: NOW, id: 'card-1' });
  // 导入卡必然带"待补全"字段：校验器必须放行（否则 ImportScreen 永远失败）
  const validation = validateCard(plan.card);
  assert.equal(validation.ok, true);
  assert.ok(validation.issues.some((issue) => issue.path === 'speech.style' && issue.severity === 'warning'));
  for (const loreCard of plan.loreCards) assert.equal(validateCard(loreCard).ok, true);

  const ports = createLocalOpPorts(createMemoryKeyValue());
  const repository = createOpLogRepository({ ops: ports.ops, settings: ports.settings, deviceId: 'device-a' });
  await repository.ready;
  await repository.cards.save(plan.card);
  for (const entry of plan.stash) await repository.stash.save(entry);
  if (plan.pack !== undefined) await repository.packs.save(plan.pack);
  for (const loreCard of plan.loreCards) await repository.cards.save(loreCard);

  assert.equal((await repository.cards.get('card-1'))?.meta.name, '星野');
  assert.equal((await repository.stash.list('card-1')).length, 2, 'scenario / 开场白两条草稿都落库');
  assert.equal((await repository.packs.list()).length, 1);
  assert.equal((await repository.cards.list('lore')).length, 2);
});

test('确定性：给定 id 与 now，同一份输入两次得到完全相同的计划', () => {
  const first = planCharacterImport(typical(), { now: NOW, id: 'card-1' });
  const second = planCharacterImport(typical(), { now: NOW, id: 'card-1' });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.pack?.id, 'card-1-worldbook');
  assert.deepEqual(first.loreCards.map((card) => card.meta.id), ['card-1-worldbook-lore-1', 'card-1-worldbook-lore-2']);

  // 不给 id 时用 ULID：非空、两次不同（跨次导入不该互相覆盖）
  const a = planCharacterImport(typical(), { now: NOW });
  const b = planCharacterImport(typical(), { now: NOW });
  assert.ok(a.card.meta.id.length > 0);
  assert.notEqual(a.card.meta.id, b.card.meta.id);
});
