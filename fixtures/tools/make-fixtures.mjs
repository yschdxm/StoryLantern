#!/usr/bin/env node
/**
 * 生成夹具（fixtures）：**真实格式**的样本文件，供导入/导出与装配语义的测试使用。
 *
 * 为什么自己生成而不是收样本：
 *  - 版权与隐私：角色卡里的立绘、真实聊天记录一律不入库，只保留格式结构；
 *  - 可重复：固定种子 + 确定性输出，任何人跑一遍得到同样的字节；
 *  - 可自检：`fixtures/test/fixtures.test.ts` 会解析这些文件，证明它们**真的是**该格式
 *    （而不是"看起来像"）。
 *
 * 用法：node fixtures/tools/make-fixtures.mjs [--large]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from '../../packages/oplog/src/crc32.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const WITH_LARGE = process.argv.includes('--large');

// ----------------------------------------------------------------- PNG 写入

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(new Uint8Array(typeAndData)), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** tEXt：keyword\0text，两者都是 Latin-1。 */
function pngTextChunk(keyword, text) {
  return pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]));
}

/** 画一个确定性的渐变方块（够用即可：夹具只关心 chunk 结构）。 */
function pngPixels(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      raw[offset] = (x * 255) / size;
      raw[offset + 1] = (y * 255) / size;
      raw[offset + 2] = ((x + y) * 255) / (size * 2);
      raw[offset + 3] = 255;
      offset += 4;
    }
  }
  return raw;
}

export function buildPng({ size = 128, texts = [] }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...texts.map(({ keyword, text }) => pngTextChunk(keyword, text)),
    pngChunk('IDAT', zlib.deflateSync(pngPixels(size))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------- ZIP 写入（store，无压缩）

export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const checksum = crc32(new Uint8Array(data));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

const base64 = (text) => Buffer.from(text, 'utf8').toString('base64');

// ----------------------------------------------------------------- 卡片数据

function cardV1() {
  return {
    name: '星野',
    description: '夜巡的守望者，话不多但记得每一个名字。',
    personality: '克制、敏锐、对旧物有执念。',
    scenario: '雪线之上的隘口，灯火将尽。',
    first_mes: '「进来吧，风会替你关门。」',
    mes_example: '<START>\n{{user}}: 你守了多久？\n{{char}}: 久到忘了数。',
  };
}

function cardV2() {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      ...cardV1(),
      creator_notes: '夹具样本：内容为占位文本，不含任何真实作品。',
      system_prompt: '你以克制的笔触叙事。{{original}}',
      post_history_instructions: '保持语气一致。{{original}}',
      alternate_greetings: ['「灯还亮着，你就还没走错路。」', '「别站在门口，雪会进来。」'],
      tags: ['fixture', 'fantasy'],
      creator: 'storylantern-fixtures',
      character_version: '1.0',
      extensions: { 'fixture/note': { generated: true }, unknown_key_must_survive: [1, 2, 3] },
      character_book: {
        name: '星野的设定',
        description: '卡片内嵌世界书（数组形式）',
        scan_depth: 3,
        token_budget: 512,
        recursive_scanning: true,
        extensions: {},
        entries: [
          {
            keys: ['铜铃'],
            content: '铜铃有一道细缝，是三年前的冬天留下的。',
            extensions: {},
            enabled: true,
            insertion_order: 10,
            case_sensitive: false,
            name: '铜铃',
            priority: 5,
            id: 0,
            comment: '随身物',
            selective: false,
            secondary_keys: [],
            constant: false,
            position: 'before_char',
          },
          {
            keys: ['雪线', '隘口'],
            content: '雪线以上没有名字，只有风。',
            extensions: {},
            enabled: true,
            insertion_order: 20,
            case_sensitive: false,
            name: '地名',
            priority: 10,
            id: 1,
            comment: '地理',
            selective: false,
            secondary_keys: [],
            constant: true,
            position: 'after_char',
          },
        ],
      },
    },
  };
}

function cardV3() {
  const v2 = cardV2();
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      ...v2.data,
      nickname: '小灯',
      creator_notes_multilingual: { en: 'Fixture sample. Placeholder text only.', 'zh-CN': '夹具样本，仅占位文本。' },
      source: ['https://example.invalid/fixture'],
      group_only_greetings: ['「你们一起进来的？那就一起坐下。」'],
      creation_date: 1_700_000_000,
      modification_date: 1_700_000_100,
      assets: [
        { type: 'icon', uri: 'embeded://assets/icon/images/avatar.png', name: 'main', ext: 'png' },
        { type: 'background', uri: 'ccdefault:', name: 'bg', ext: 'png' },
      ],
    },
  };
}

function stWorldBook() {
  const entry = (uid, overrides) => ({
    uid,
    key: ['灯', '灯火'],
    keysecondary: ['夜'],
    comment: `条目 ${uid}`,
    content: `与灯有关的设定 ${uid}：灯油价高，但能从风里认路。`,
    constant: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: 'place',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    vectorized: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    displayIndex: uid,
    ...overrides,
  });
  return {
    entries: {
      0: entry(0, { key: ['灯'], content: '灯是这条路上唯一不会说谎的东西。', position: 0 }),
      1: entry(1, { key: ['铜铃'], keysecondary: [], content: '铜铃响的时候，别回头。', position: 1 }),
      2: entry(2, { key: ['隘口'], content: '隘口在第三次钟响后关闭，无人例外。', position: 4, depth: 2 }),
    },
  };
}

function ccv3Lorebook() {
  return {
    spec: 'lorebook_v3',
    data: {
      name: '独立世界书',
      description: 'CCv3 形式：entries 是数组，且允许 decorator',
      scan_depth: 4,
      token_budget: 1024,
      recursive_scanning: false,
      extensions: {},
      entries: [
        {
          id: 'decorated',
          keys: ['河流'],
          content: '@@depth 3\n@@role system\n没有名字的河在松林北侧，水很浅。',
          use_regex: false,
          enabled: true,
          insertion_order: 30,
          case_sensitive: false,
          name: '无名的河',
          priority: 20,
          comment: '带 decorator',
          selective: false,
          secondary_keys: [],
          constant: false,
          position: 'before_char',
          extensions: { 'fixture/decorator': true },
        },
      ],
    },
  };
}

/** 卡片内嵌世界书用 **map** 形态（现实中两种混着出现）。 */
function cardV3EmbeddedMapBook() {
  const v3 = cardV3();
  return {
    ...v3,
    data: {
      ...v3.data,
      character_book: {
        name: '内嵌 map 形态',
        entries: {
          0: { key: ['雪'], content: '雪落下来的时候，隘口会安静得不像话。', comment: '雪', enabled: true },
          1: { key: ['灯'], content: '灯的油只够撑到天亮。', comment: '灯', disable: true },
        },
      },
    },
  };
}

/** 字段大量留空的最小卡（导入器不能因为空字段就炸）。 */
function cardV2EmptyFields() {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name: '空白样本', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' },
  };
}

/** 扁平 legacy 最小卡。 */
function cardLegacyMinimal() {
  return { name: '最小卡', first_mes: '嗯。' };
}

/** 中文/emoji/换行混杂：编码边界（PNG 里是 base64(UTF-8)，JSONL 里是 UTF-8）。 */
function cardV3Unicode() {
  const v3 = cardV3();
  return {
    ...v3,
    data: {
      ...v3.data,
      name: '霜·🌙',
      description: '带 emoji 的描述 ✨\n第二行：「引号」、“弯引号”、\u0000后无空格。',
      mes_example: '<START>\n{{user}}: 🙂\n{{char}}: 🙂‍↔️',
    },
  };
}

/** 单条目、默认关闭的世界书。 */
function stWorldSingle() {
  return {
    entries: {
      7: { uid: 7, key: ['孤灯'], comment: '唯一一条', content: '只有一盏灯还亮着。', disable: true, order: 1 },
    },
  };
}

/** CCv3 spec 但 entries 是 map（现实里见过的不规范导出）。 */
function ccv3LorebookMapEntries() {
  return {
    spec: 'lorebook_v3',
    data: {
      name: '不规范的 CCv3',
      entries: {
        0: { keys: ['风'], content: '风会替你关门。', enabled: true },
        1: { keys: ['雪'], content: '雪线以上没有名字。', enabled: true },
      },
    },
  };
}

/** 没有表头的聊天：名字只写在每一行上。 */
function buildChatNoHeader() {
  return `${[
    JSON.stringify({ name: '旅人', is_user: true, mes: '没有表头的一行。', send_date: 1_700_000_000_000 }),
    JSON.stringify({ name: '星野', is_user: false, mes: '嗯。', send_date: 1_700_000_001_000 }),
  ].join('\n')}\n`;
}

/** 只有 system 与两句话的聊天（最少可导入形态）。 */
function buildChatSystemOnly() {
  return `${[
    JSON.stringify(chatHeader()),
    JSON.stringify({ name: '系统', is_user: false, is_system: true, mes: '会话开始。', send_date: 1_700_000_000_000 }),
    JSON.stringify(chatMessage(0)),
  ].join('\n')}\n`;
}

// ----------------------------------------------------------------- 聊天

function chatHeader(overrides = {}) {
  return {
    user_name: '旅人',
    character_name: '星野',
    create_date: 1_700_000_000_000,
    chat_metadata: { integrity: 'fixture', note: '占位样本' },
    ...overrides,
  };
}

function chatMessage(index, overrides = {}) {
  const isUser = index % 2 === 0;
  return {
    name: isUser ? '旅人' : '星野',
    is_user: isUser,
    is_system: false,
    send_date: 1_700_000_000_000 + index * 1000,
    mes: `第 ${index + 1} 段：${isUser ? '我把地图摊开，指给你看那道隘口。' : '她只抬眼看了一下，然后把灯芯挑高。'}`,
    extra: { fixture: true, index },
    swipes: [`第 ${index + 1} 段候选 A`, `第 ${index + 1} 段候选 B`],
    swipe_id: 0,
    swipe_info: [{ send_date: 1_700_000_000_000 + index * 1000, gen_started: 1_700_000_000_000, gen_finished: 1_700_000_001_000 }],
    ...overrides,
  };
}

export function buildSingleChat(count) {
  const lines = [JSON.stringify(chatHeader())];
  for (let index = 0; index < count; index += 1) lines.push(JSON.stringify(chatMessage(index)));
  return `${lines.join('\n')}\n`;
}

export function buildGroupChat() {
  const lines = [JSON.stringify(chatHeader({ character_name: '群聊' }))];
  lines.push(JSON.stringify(chatMessage(0)));
  lines.push(
    JSON.stringify({
      name: '系统',
      is_user: false,
      is_system: true,
      send_date: 1_700_000_010_000,
      mes: '星野加入了对话。',
      extra: { fixture: true },
      swipes: [],
      swipe_id: 0,
    }),
  );
  lines.push(JSON.stringify(chatMessage(1, { name: '岚', extra: { fixture: true, member: '岚' } })));
  return `${lines.join('\n')}\n`;
}

// ----------------------------------------------------------------- 预设与正则

function chatCompletionPreset() {
  return {
    temperature: 0.9,
    frequency_penalty: 0.2,
    presence_penalty: 0.1,
    top_p: 0.95,
    openai_max_context: 8192,
    openai_max_tokens: 1024,
    wrap_in_quotes: false,
    names_behavior: 0,
    send_if_empty: '',
    impersonation_prompt: '[Write your next reply from the point of view of {{user}}.]',
    new_chat_prompt: '[Start a new chat]',
    new_group_chat_prompt: '[Start a new group chat]',
    prompts: [
      { identifier: 'main', name: '主提示', system_prompt: true, role: 'system', content: '你以克制的笔触叙事。' },
      { identifier: 'worldInfoBefore', name: '世界书（前）', system_prompt: true, role: 'system', content: '' },
      { identifier: 'charDescription', name: '角色描述', system_prompt: true, role: 'system', content: '' },
      { identifier: 'chatHistory', name: '聊天记录', system_prompt: true, role: 'system', content: '' },
      { identifier: 'worldInfoAfter', name: '世界书（后）', system_prompt: true, role: 'system', content: '' },
      { identifier: 'jailbreak', name: '越狱', system_prompt: true, role: 'system', content: '保持语气一致。' },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'worldInfoBefore', enabled: true },
          { identifier: 'charDescription', enabled: true },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'worldInfoAfter', enabled: true },
          { identifier: 'jailbreak', enabled: true },
        ],
      },
    ],
  };
}

function textCompletionPreset() {
  return {
    temp: 0.8,
    top_k: 40,
    top_p: 0.9,
    rep_pen: 1.1,
    story_string: '{{#if system}}{{system}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if scenario}}Scenario: {{scenario}}\n{{/if}}{{#if personality}}{{personality}}\n{{/if}}',
    chat_start: '***',
    example_separator: '***',
    name: '夹具叙事模板',
  };
}

function regexScripts() {
  return [
    {
      id: 'fixture-strip-ooc',
      scriptName: '去掉 OOC 括号',
      findRegex: '/\\(OOC:.*?\\)/gs',
      replaceString: '',
      trimStrings: [],
      placement: [2],
      disabled: false,
      markdownOnly: false,
      promptOnly: true,
      runOnEdit: true,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    },
    {
      id: 'fixture-worldinfo-flag',
      scriptName: '世界书里标注来源',
      findRegex: '/^/',
      replaceString: '[lore] ',
      trimStrings: [],
      placement: [5],
      disabled: false,
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: false,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    },
  ];
}

// ----------------------------------------------------------------- 畸形样本

function malformed() {
  return {
    'truncated-card.png': buildPng({ size: 32, texts: [{ keyword: 'chara', text: base64(JSON.stringify(cardV2())) }] }).subarray(0, 60),
    'bad-card.json': '{"spec": "chara_card_v2", "data": {"name": "缺逗号" "description": "坏了"}}',
    'bad-chat.jsonl': [
      JSON.stringify(chatHeader()),
      JSON.stringify(chatMessage(0)),
      '{"name": "坏行", "mes": "少了大括号"',
      JSON.stringify(chatMessage(1)),
    ].join('\n'),
    'deep-nesting.json': `${'['.repeat(400)}1${']'.repeat(400)}`,
    'empty.json': '',
    // 没有名字的卡：导入必须报 bad-card，而不是"导入一张无名卡"
    'card-no-name.json': JSON.stringify({ spec: 'chara_card_v2', data: { description: '只有描述' } }),
    // 空世界书：必须报 bad-lorebook
    'lorebook-empty.json': JSON.stringify({ entries: {} }),
    // 压缩包里没有 card.json：必须报 no-card-in-charx
    'zip-no-card.charx': buildZip([{ name: 'readme.txt', data: '没有卡片' }]),
  };
}

// ----------------------------------------------------------------- 主流程

export const FIXTURE_MANIFEST = {
  cards: [
    'card-v1.json',
    'card-v2.json',
    'card-v3.json',
    'card-v2.png',
    'card-v3.png',
    'card.charx',
    'card-v3-embedded-map.json',
    'card-v2-empty-fields.json',
    'card-legacy-minimal.json',
    'card-v3-unicode.json',
  ],
  lorebooks: ['st-world.json', 'ccv3-lorebook.json', 'st-world-single.json', 'ccv3-lorebook-map.json'],
  chats: ['single.jsonl', 'group.jsonl', 'no-header.jsonl', 'system-only.jsonl'],
  presets: ['chat-completion.json', 'text-completion.json'],
  regex: ['scripts.json'],
  malformed: [
    'truncated-card.png',
    'bad-card.json',
    'bad-chat.jsonl',
    'deep-nesting.json',
    'empty.json',
    'card-no-name.json',
    'lorebook-empty.json',
    'zip-no-card.charx',
  ],
};

async function main() {
  const dirs = ['cards', 'lorebooks', 'chats', 'presets', 'regex', 'malformed'];
  for (const dir of dirs) await mkdir(path.join(ROOT, dir), { recursive: true });

  const write = (rel, data) => writeFile(path.join(ROOT, rel), data);

  const v2 = cardV2();
  const v3 = cardV3();

  // 卡片
  await write('cards/card-v1.json', `${JSON.stringify(cardV1(), null, 2)}\n`);
  await write('cards/card-v2.json', `${JSON.stringify(v2, null, 2)}\n`);
  await write('cards/card-v3.json', `${JSON.stringify(v3, null, 2)}\n`);
  await write('cards/card-v2.png', buildPng({ size: 128, texts: [{ keyword: 'chara', text: base64(JSON.stringify(v2)) }] }));
  await write(
    'cards/card-v3.png',
    buildPng({
      size: 128,
      texts: [
        // 故意同时写入两个 chunk：规范要求优先读 ccv3
        { keyword: 'chara', text: base64(JSON.stringify(v2)) },
        { keyword: 'ccv3', text: base64(JSON.stringify(v3)) },
      ],
    }),
  );
  await write(
    'cards/card.charx',
    buildZip([
      { name: 'card.json', data: `${JSON.stringify(v3, null, 2)}\n` },
      { name: 'assets/icon/images/avatar.png', data: buildPng({ size: 32 }) },
    ]),
  );

  // 世界书
  await write('lorebooks/st-world.json', `${JSON.stringify(stWorldBook(), null, 2)}\n`);
  await write('lorebooks/ccv3-lorebook.json', `${JSON.stringify(ccv3Lorebook(), null, 2)}\n`);
  await write('lorebooks/st-world-single.json', `${JSON.stringify(stWorldSingle(), null, 2)}\n`);
  await write('lorebooks/ccv3-lorebook-map.json', `${JSON.stringify(ccv3LorebookMapEntries(), null, 2)}\n`);

  // 更多卡片形态
  await write('cards/card-v3-embedded-map.json', `${JSON.stringify(cardV3EmbeddedMapBook(), null, 2)}\n`);
  await write('cards/card-v2-empty-fields.json', `${JSON.stringify(cardV2EmptyFields(), null, 2)}\n`);
  await write('cards/card-legacy-minimal.json', `${JSON.stringify(cardLegacyMinimal(), null, 2)}\n`);
  await write('cards/card-v3-unicode.json', `${JSON.stringify(cardV3Unicode(), null, 2)}\n`);

  // 聊天
  await write('chats/single.jsonl', buildSingleChat(6));
  await write('chats/group.jsonl', buildGroupChat());
  await write('chats/no-header.jsonl', buildChatNoHeader());
  await write('chats/system-only.jsonl', buildChatSystemOnly());

  // 预设与正则
  await write('presets/chat-completion.json', `${JSON.stringify(chatCompletionPreset(), null, 2)}\n`);
  await write('presets/text-completion.json', `${JSON.stringify(textCompletionPreset(), null, 2)}\n`);
  await write('regex/scripts.json', `${JSON.stringify(regexScripts(), null, 2)}\n`);

  // 畸形样本
  const bad = malformed();
  for (const [name, data] of Object.entries(bad)) await write(`malformed/${name}`, data);

  // 大聊天默认不生成（体积大且可重建）；测试需要时加 --large
  if (WITH_LARGE) {
    await write('chats/large.jsonl', buildSingleChat(5000));
    console.log('已生成 chats/large.jsonl（5000 条消息）');
  }

  const total = Object.values(FIXTURE_MANIFEST).flat().length + (WITH_LARGE ? 1 : 0);
  console.log(`夹具已生成：${total} 个文件${WITH_LARGE ? '（含 large）' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('make-fixtures.mjs')) {
  await main();
}
