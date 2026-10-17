import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HlcClock,
  Materializer,
  cardDelete,
  characterUpsert,
  liveCard,
  liveStash,
  listCards,
  listPacks,
  lorebookUpsert,
  loreEntryUpsert,
  sessionCreate,
  setupOf,
  type Op,
} from '../../../packages/oplog/src/index.ts';
import type { CharacterCard, LoreCard } from '../../../packages/cards/src/index.ts';
import { migrateLegacyToCards } from '../src/data/migrate-cards.ts';

/**
 * 旧数据 → 卡片模型的迁移测试。
 *
 * 三条性质必须钉死：**确定性**（两台设备算出的 op 逐字节一样）、
 * **幂等**（应用后再跑一次是 0 条）、**映射正确**（字段/计数/顺序）。
 */

const T = 1_700_000_000_000;

function legacyBase(): () => { deviceId: string; clock: HlcClock } {
  const clock = new HlcClock({ now: () => T });
  return () => ({ deviceId: 'old-device', clock });
}

function characterOp(id: string, extra: { scenario?: string; firstMessage?: string; exampleDialogue?: string; alternateGreetings?: string[] } = {}): Op {
  return characterUpsert(
    legacyBase()(),
    {
      characterId: id,
      name: id === 'char-1' ? '星野' : '旅人',
      description: '夜巡的守望者',
      personality: '沉默\n寡言',
      scenario: extra.scenario ?? '',
      firstMessage: extra.firstMessage ?? '',
      exampleDialogue: extra.exampleDialogue ?? '',
      ...(extra.alternateGreetings === undefined ? {} : { alternateGreetings: extra.alternateGreetings }),
    },
    { hlc: { t: T, c: 0 } },
  );
}

function singleCharacterOps(): Op[] {
  return [
    characterOp('char-1', {
      scenario: '雨夜边境酒馆',
      firstMessage: '「进来吧。」',
      alternateGreetings: ['「门没锁。」'],
    }),
  ];
}

/** 一份"全套旧数据"：两个角色、一个会话、一本世界书（2 条）。用于确定性对比。 */
function fullLegacyOps(): Op[] {
  const base = legacyBase();
  return [
    characterOp('char-1', { scenario: '雨夜边境酒馆', firstMessage: '「进来吧。」' }),
    characterOp('char-2', { scenario: '雪线之上', firstMessage: '「冷吗？」' }),
    sessionCreate(base(), { sessionId: 'sess-1', title: '星野', characterId: 'char-1' }, { hlc: { t: T, c: 1 } }),
    lorebookUpsert(
      base(),
      { lorebookId: 'book-1', name: '边境城', description: '边境设定', characterIds: [], enabled: true },
      { hlc: { t: T, c: 2 } },
    ),
    loreEntryUpsert(
      base(),
      {
        lorebookId: 'book-1',
        entryId: 'entry-1',
        keys: ['铜铃'],
        secondaryKeys: ['遗物'],
        content: '铜铃是父亲留下来的遗物。',
        enabled: true,
        order: 10,
        caseSensitive: false,
        recursive: true,
        depth: 0,
        constant: false,
        comment: '遗物',
      },
      { hlc: { t: T, c: 3 } },
    ),
    loreEntryUpsert(
      base(),
      {
        lorebookId: 'book-1',
        entryId: 'entry-2',
        keys: ['王都'],
        secondaryKeys: [],
        content: '王都的钟楼已经停了三年。',
        enabled: false,
        order: 20,
        caseSensitive: false,
        recursive: false,
        depth: 4,
        constant: false,
      },
      { hlc: { t: T, c: 4 } },
    ),
  ];
}

test('迁移：单个旧角色 → 1 卡 + 2 草稿 + 0 包；opId/HLC/deviceId 确定', () => {
  const materializer = new Materializer();
  materializer.applyAll(singleCharacterOps());

  const result = migrateLegacyToCards(materializer.state);
  assert.equal(result.cards, 1);
  assert.equal(result.stash, 2);
  assert.equal(result.packs, 0);
  assert.equal(result.setups, 0);
  assert.deepEqual(result.ops.map((op) => op.opId), [
    'legacy-card-char-1',
    'legacy-stash-scenario-char-1',
    'legacy-stash-opening-char-1',
  ]);
  for (const op of result.ops) {
    assert.equal(op.deviceId, 'legacy-migration', 'deviceId 固定，跨设备 op 才逐字节一致');
    assert.equal(op.hlc.t, T);
    assert.equal(op.hlc.c, 0);
  }

  materializer.applyAll(result.ops);
  const card = liveCard(materializer.state, 'char-1')?.card;
  assert.ok(card !== undefined && card.card_type === 'character');
  assert.equal(card.meta.name, '星野');
  assert.equal(card.meta.schema, 'rolecard/v1');
  assert.equal(card.meta.description, '夜巡的守望者');
  assert.equal(card.identity.background, '夜巡的守望者');
  assert.equal(card.persona.summary, '沉默', 'summary 取 personality 第一行');
  assert.deepEqual([...card.persona.traits], ['沉默', '寡言']);
  assert.equal(card.persona.knowledge_boundary, '', '有意留空：校验器只报 warning');
  assert.equal(card.speech.style, '');

  const stash = liveStash(materializer.state).map((record) => record.entry);
  assert.deepEqual(stash.map((entry) => entry.id).sort(), [
    'legacy-stash-opening-char-1',
    'legacy-stash-scenario-char-1',
  ]);
  assert.equal(stash.find((entry) => entry.kind === 'scenario')?.text, '雨夜边境酒馆');
  assert.equal(
    stash.find((entry) => entry.kind === 'opening')?.text,
    '「进来吧。」\n\n---\n\n「门没锁。」',
    '主开场白在前，备选接在后面且保留原文',
  );
});

test('迁移：幂等——把生成的 op 应用后再跑一次返回 0 条', () => {
  const materializer = new Materializer();
  materializer.applyAll(singleCharacterOps());
  const first = migrateLegacyToCards(materializer.state);
  assert.equal(first.ops.length, 3);
  materializer.applyAll(first.ops);

  const second = migrateLegacyToCards(materializer.state);
  assert.deepEqual(second, { ops: [], cards: 0, setups: 0, packs: 0, stash: 0 });
});

test('迁移：两台设备各自迁移同一份旧状态 → ops 序列完全一致', () => {
  const ops = fullLegacyOps();
  const deviceA = new Materializer();
  deviceA.applyAll(ops);
  const deviceB = new Materializer();
  // 对端按相反顺序收到同一批 op（applyAll 内部按 HLC 重放，状态相同）
  deviceB.applyAll([...ops].reverse());

  const a = migrateLegacyToCards(deviceA.state);
  const b = migrateLegacyToCards(deviceB.state);
  assert.equal(JSON.stringify(a.ops), JSON.stringify(b.ops), 'opId/HLC/deviceId/payload 必须逐字节相同');
  assert.deepEqual({ cards: a.cards, setups: a.setups, packs: a.packs, stash: a.stash }, {
    cards: b.cards,
    setups: b.setups,
    packs: b.packs,
    stash: b.stash,
  });
});

test('迁移：op 顺序稳定 = 先 cards，再 stash，再 packs，最后 setups', () => {
  const materializer = new Materializer();
  materializer.applyAll(fullLegacyOps());
  const result = migrateLegacyToCards(materializer.state);
  const typeOrder = result.ops.map((op) => op.type);
  const rank = (type: string): number =>
    type === 'card.upsert' ? 0 : type === 'stash.upsert' ? 1 : type === 'pack.upsert' ? 2 : type === 'session.setup' ? 3 : 9;
  for (let index = 1; index < typeOrder.length; index += 1) {
    assert.ok(rank(typeOrder[index] ?? '') >= rank(typeOrder[index - 1] ?? ''), `op 顺序必须分组稳定：${typeOrder.join(', ')}`);
  }
  assert.equal(result.cards, 4, '2 张角色卡 + 2 条典籍卡');
  assert.equal(result.stash, 4, '两个旧角色各自 scenario + opening 各一条');
  assert.equal(result.packs, 1);
  assert.equal(result.setups, 1);
});

test('迁移：旧世界书 2 条 → 1 个包 + 2 张典籍卡（含触发与禁用标记）', () => {
  const materializer = new Materializer();
  materializer.applyAll(fullLegacyOps());
  const result = migrateLegacyToCards(materializer.state);
  materializer.applyAll(result.ops);

  assert.equal(listPacks(materializer.state).length, 1);
  const pack = listPacks(materializer.state)[0]?.pack;
  assert.ok(pack !== undefined);
  assert.equal(pack.schema, 'worldpack/v1');
  assert.equal(pack.name, '边境城');
  assert.equal(pack.version, '1.0.0');
  assert.deepEqual([...pack.card_ids], ['entry-1', 'entry-2']);

  assert.equal(listCards(materializer.state, 'lore').length, 2);
  const first = liveCard(materializer.state, 'entry-1')?.card;
  assert.ok(first !== undefined && first.card_type === 'lore');
  assert.equal(first.meta.name, '铜铃', 'name 优先用第一个触发词（旧 comment 常是 provenance，拿它当名字会全是哈希）');
  assert.equal(first.meta.description, '铜铃是父亲留下来的遗物。', '简介用正文首行');
  assert.equal(first.kind, 'other');
  assert.equal(first.content, '铜铃是父亲留下来的遗物。');
  assert.deepEqual([...first.keys], ['铜铃']);
  assert.deepEqual([...(first.secondary_keys ?? [])], ['遗物']);
  assert.equal(first.trigger?.constant, false);
  assert.equal(first.trigger?.priority, 10);
  assert.equal(first.trigger?.recursive, true);
  assert.equal('depth' in (first.trigger ?? {}), false, 'depth=0 表示默认窗口，应省略字段');
  assert.equal(first.meta.tags, undefined);

  const second = liveCard(materializer.state, 'entry-2')?.card as LoreCard | undefined;
  assert.ok(second !== undefined);
  assert.equal(second.meta.name, '王都', '没有 comment 时用第一个 key');
  assert.equal(second.enabled, false, '旧 enabled=false 映射到条目级启停字段（正式字段，不再用 tags 打标记）');
  assert.equal(second.trigger?.depth, 4);
});

test('迁移：旧会话 → setup.premise 来自该角色的 scenario 草稿', () => {
  const materializer = new Materializer();
  materializer.applyAll(fullLegacyOps());
  const result = migrateLegacyToCards(materializer.state);
  materializer.applyAll(result.ops);

  const setup = setupOf(materializer.state, 'sess-1')?.setup;
  assert.ok(setup !== undefined);
  assert.deepEqual([...setup.characters], ['char-1']);
  assert.equal(setup.premise, '雨夜边境酒馆');
  assert.equal(setup.opening_mode, 'designated');
  assert.equal(setup.opening_speaker, 'char-1');
  assert.equal(setup.origin, 'card');
  assert.equal(setupOf(materializer.state, 'sess-2'), undefined);
});

test('迁移：示例对话每行都有角色前缀时落成结构化 examples；混合形态原文进 stash', () => {
  const structured = new Materializer();
  structured.applyAll([
    characterOp('char-1', { exampleDialogue: '{{user}}: 你好\n{{char}}: 你也好' }),
  ]);
  const structuredResult = migrateLegacyToCards(structured.state);
  structured.applyAll(structuredResult.ops);
  const card = liveCard(structured.state, 'char-1')?.card;
  assert.ok(card !== undefined && card.card_type === 'character');
  assert.equal(card.examples?.length, 1);
  assert.equal(card.examples?.[0]?.id, 'char-1-example-1');
  assert.deepEqual(
    card.examples?.[0]?.messages.map((message) => message.role),
    ['user', 'assistant'],
  );
  assert.equal(card.examples?.[0]?.messages[1]?.content, '你也好');

  const mixed = new Materializer();
  mixed.applyAll([characterOp('char-1', { exampleDialogue: '{{user}}: 你好\n没有前缀的一行' })]);
  const mixedResult = migrateLegacyToCards(mixed.state);
  mixed.applyAll(mixedResult.ops);
  const mixedCard = liveCard(mixed.state, 'char-1')?.card as CharacterCard | undefined;
  assert.ok(mixedCard !== undefined);
  // 结构不可靠时不猜说话人，但**内容不能丢**：给模型的那份按每行一条 assistant 示例落进卡片
  assert.equal(mixedCard.examples?.[0]?.tags?.[0], 'legacy-unparsed');
  assert.deepEqual(
    mixedCard.examples?.[0]?.messages.map((message) => message.content),
    ['{{user}}: 你好', '没有前缀的一行'],
  );
  const examplesStash = liveStash(mixed.state).find((record) => record.entry.source === 'legacy:character.exampleDialogue');
  assert.equal(examplesStash?.entry.text, '{{user}}: 你好\n没有前缀的一行', '原文另外进 stash，保留可读格式');
});

test('迁移：已存在的实体不会重复生成（含墓碑）', () => {
  const materializer = new Materializer();
  materializer.applyAll(singleCharacterOps());
  materializer.applyAll(migrateLegacyToCards(materializer.state).ops);
  // 删掉迁移出来的卡：墓碑也要挡住第二次迁移（不能把用户删掉的卡"复活"）
  materializer.apply(cardDelete(legacyBase()(), { card_id: 'char-1' }, { hlc: { t: T + 10, c: 0 } }));

  const again = migrateLegacyToCards(materializer.state);
  assert.equal(again.ops.length, 0, 'state.cards 存在（含墓碑）就跳过');
  assert.equal(again.cards, 0);
});
