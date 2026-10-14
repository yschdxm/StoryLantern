import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from '../../packages/oplog/src/crc32.ts';

/**
 * 夹具自检：证明 `fixtures/` 里的样本**真的是**目标格式。
 *
 * 为什么需要这层：夹具是"导入必须无损"这条验收的基准。如果夹具本身是错的，
 * 之后所有往返测试都会建立在错误基准上——而且看起来一切正常。
 * 所以这里不调我们的解析器（那会自证），而是**按格式规范手写解析**。
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (relative: string) => readFile(path.join(ROOT, relative));
const readText = async (relative: string) => (await read(relative)).toString('utf8');
const readJson = async (relative: string) => JSON.parse(await readText(relative)) as Record<string, unknown>;

// ---------------------------------------------------------------- PNG

interface PngChunk {
  type: string;
  data: Buffer;
}

function parsePng(bytes: Buffer): PngChunk[] {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual([...bytes.subarray(0, 8)], [...signature], 'PNG 签名不对');

  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const stored = bytes.readUInt32BE(offset + 8 + length);
    const actual = crc32(new Uint8Array(bytes.subarray(offset + 4, offset + 8 + length)));
    assert.equal(stored, actual, `chunk ${type} 的 CRC 不匹配`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

function readTextChunk(chunks: PngChunk[], keyword: string): string | undefined {
  for (const chunk of chunks) {
    if (chunk.type !== 'tEXt') continue;
    const separator = chunk.data.indexOf(0);
    if (separator < 0) continue;
    if (chunk.data.subarray(0, separator).toString('latin1') === keyword) {
      return chunk.data.subarray(separator + 1).toString('latin1');
    }
  }
  return undefined;
}

function decodeCardFromPng(bytes: Buffer, keyword: string): Record<string, unknown> {
  const chunks = parsePng(bytes);
  const text = readTextChunk(chunks, keyword);
  assert.ok(text, `PNG 里没有 ${keyword} chunk`);
  return JSON.parse(Buffer.from(text as string, 'base64').toString('utf8')) as Record<string, unknown>;
}

test('PNG 角色卡：chara chunk 是合法的 base64(UTF-8 JSON)，且字符卡字段完整', async () => {
  const card = decodeCardFromPng(await read('cards/card-v2.png'), 'chara');
  assert.equal(card.spec, 'chara_card_v2');
  const data = card.data as Record<string, unknown>;
  assert.equal(data.name, '星野');
  assert.equal(typeof data.first_mes, 'string');
  assert.ok(Array.isArray(data.alternate_greetings));
  assert.ok((data.character_book as { entries: unknown[] }).entries.length === 2);
  assert.equal((data.extensions as Record<string, unknown>).unknown_key_must_survive !== undefined, true);
});

test('PNG 同时含 chara 与 ccv3 时：ccv3 是 V3 卡（规范要求优先读它）', async () => {
  const bytes = await read('cards/card-v3.png');
  const fromChara = decodeCardFromPng(bytes, 'chara');
  const fromCcv3 = decodeCardFromPng(bytes, 'ccv3');

  assert.equal(fromChara.spec, 'chara_card_v2');
  assert.equal(fromCcv3.spec, 'chara_card_v3');
  assert.equal(fromCcv3.spec_version, '3.0');
  const data = fromCcv3.data as Record<string, unknown>;
  assert.equal(data.nickname, '小灯');
  assert.ok(Array.isArray(data.group_only_greetings));
  assert.ok(Array.isArray(data.assets));
  assert.equal((data.assets as Array<{ uri: string }>)[0]?.uri, 'embeded://assets/icon/images/avatar.png');
});

test('CHARX（zip）：根目录有 card.json，资源以 embeded:// 引用', async () => {
  const bytes = await read('cards/card.charx');
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, '不是 zip（缺少本地文件头）');

  // 手写解析：只关心名字与内容（store 方式，无压缩）
  const names: string[] = [];
  const contents = new Map<string, Buffer>();
  let offset = 0;
  while (offset < bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const data = bytes.subarray(offset + 30 + nameLength + extraLength, offset + 30 + nameLength + extraLength + compressedSize);
    names.push(name);
    contents.set(name, data);
    offset += 30 + nameLength + extraLength + compressedSize;
  }

  assert.ok(names.includes('card.json'), `CHARX 缺少 card.json，实际：${names.join(', ')}`);
  assert.ok(names.some((name) => name.startsWith('assets/icon/images/')), '缺少 icon 资源');

  const card = JSON.parse((contents.get('card.json') as Buffer).toString('utf8')) as Record<string, unknown>;
  assert.equal(card.spec, 'chara_card_v3');
  const asset = (card.data as { assets: Array<{ uri: string }> }).assets[0];
  const assetPath = (asset?.uri ?? '').replace('embeded://', '');
  assert.ok(contents.has(assetPath), `card.json 引用的资源不存在：${assetPath}`);
  // 资源本身应当是合法 PNG
  parsePng(contents.get(assetPath) as Buffer);
});

// ---------------------------------------------------------------- 世界书

test('世界书两种形态：ST 原生是 uid→条目 map，CCv3 是数组且带 decorator', async () => {
  const st = await readJson('lorebooks/st-world.json');
  const entries = st.entries as Record<string, Record<string, unknown>>;
  assert.ok(!Array.isArray(entries), 'ST 原生必须是 map 而不是数组');
  const first = entries['0'] as Record<string, unknown>;
  assert.deepEqual(first.key, ['灯']);
  assert.equal(typeof first.content, 'string');
  assert.equal(typeof first.selectiveLogic, 'number');
  assert.equal(typeof first.position, 'number');
  assert.equal(typeof first.order, 'number');

  const ccv3 = await readJson('lorebooks/ccv3-lorebook.json');
  assert.equal(ccv3.spec, 'lorebook_v3');
  const data = ccv3.data as { entries: Array<Record<string, unknown>> };
  assert.ok(Array.isArray(data.entries), 'CCv3 必须是数组');
  assert.match(String(data.entries[0]?.content), /^@@depth 3\n@@role system\n/);
});

// ---------------------------------------------------------------- 聊天

test('聊天 JSONL：首行是 header，其后每行都有 mes/name/is_user', async () => {
  const text = await readText('chats/single.jsonl');
  assert.equal(text.endsWith('\n'), true);
  const lines = text.trim().split('\n');
  const header = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(header.user_name, '旅人');
  assert.equal(header.character_name, '星野');
  assert.equal(typeof header.create_date, 'number');
  assert.ok(header.chat_metadata !== undefined);

  assert.equal(lines.length, 7, 'header + 6 条消息');
  for (const line of lines.slice(1)) {
    const message = JSON.parse(line) as Record<string, unknown>;
    assert.equal(typeof message.mes, 'string');
    assert.equal(typeof message.name, 'string');
    assert.equal(typeof message.is_user, 'boolean');
    assert.ok(Array.isArray(message.swipes));
    assert.equal(typeof message.swipe_id, 'number');
    assert.ok(Array.isArray(message.swipe_info));
  }
});

test('群聊：包含 is_system 的消息，且成员名不等于角色名', async () => {
  const lines = (await readText('chats/group.jsonl')).trim().split('\n');
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal((parsed[0] as { character_name: string }).character_name, '群聊');
  assert.ok(parsed.some((message) => message.is_system === true), '缺少 is_system 样本');
  assert.ok(parsed.some((message) => message.name === '岚'), '缺少非主角成员的样本');
});

// ---------------------------------------------------------------- 预设与正则

test('Chat Completion 预设：prompts[] 与 prompt_order[] 都指向已定义的 identifier', async () => {
  const preset = await readJson('presets/chat-completion.json');
  const prompts = preset.prompts as Array<{ identifier: string }>;
  const orders = preset.prompt_order as Array<{ character_id: number; order: Array<{ identifier: string }> }>;
  assert.ok(Array.isArray(prompts) && prompts.length > 0);
  assert.equal(typeof preset.temperature, 'number');
  assert.equal(typeof preset.openai_max_context, 'number');

  const known = new Set(prompts.map((prompt) => prompt.identifier));
  for (const group of orders) {
    assert.equal(typeof group.character_id, 'number');
    for (const item of group.order) {
      assert.ok(known.has(item.identifier), `prompt_order 引用了未定义的 identifier：${item.identifier}`);
    }
  }
});

test('Text Completion 预设：含 story_string 与采样参数', async () => {
  const preset = await readJson('presets/text-completion.json');
  assert.match(String(preset.story_string), /\{\{#if system\}\}/);
  assert.equal(typeof preset.temp, 'number');
  assert.equal(typeof preset.rep_pen, 'number');
});

test('正则脚本：placement 是数组、findRegex 是带斜杠的正则字面量', async () => {
  const scripts = JSON.parse(await readText('regex/scripts.json')) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(scripts) && scripts.length >= 2);
  for (const script of scripts) {
    assert.equal(typeof script.scriptName, 'string');
    assert.ok(Array.isArray(script.placement) && (script.placement as number[]).length > 0);
    assert.match(String(script.findRegex), /^\/.*\/[a-z]*$/s, 'findRegex 应当是 /pattern/flags 形式');
    assert.ok(Array.isArray(script.trimStrings));
  }
});

// ---------------------------------------------------------------- 畸形样本（负样本也要"真的是坏的"）

test('畸形样本确实是坏的：解析必须失败，而不是"看起来能读"', async () => {
  // 截断的 PNG：连签名之后的结构都不完整
  const truncated = await read('malformed/truncated-card.png');
  assert.equal(truncated.length, 60);
  await assert.rejects(async () => parsePng(truncated), /PNG|CRC|chunk|AssertionError|out of range|bounds/i);

  // 坏 JSON
  await assert.rejects(async () => JSON.parse(await readText('malformed/bad-card.json')));

  // 坏 JSONL：中间某一行不合法（导入必须整体失败，而不是部分接受）
  const lines = (await readText('malformed/bad-chat.jsonl')).trim().split('\n');
  let badLines = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      badLines += 1;
    }
  }
  assert.equal(badLines, 1, '坏 JSONL 应当只有一行是坏的');

  // 超深嵌套：能解析，但深度本身就是输入校验要拦的东西
  const deep = JSON.parse(await readText('malformed/deep-nesting.json')) as unknown;
  let depth = 0;
  let cursor: unknown = deep;
  while (Array.isArray(cursor)) {
    depth += 1;
    cursor = cursor[0];
  }
  assert.ok(depth >= 300, `嵌套深度应当很深，实际 ${depth}`);

  // 空文件
  assert.equal((await read('malformed/empty.json')).length, 0);
});

// ---------------------------------------------------------------- 与夹具清单一致

test('夹具清单与实际文件一致（避免"文档说有、盘上没有"）', async () => {
  const { FIXTURE_MANIFEST } = await import('../tools/make-fixtures.mjs');
  for (const [dir, files] of Object.entries(FIXTURE_MANIFEST as Record<string, string[]>)) {
    for (const file of files) {
      const bytes = await read(`${dir}/${file}`);
      assert.ok(bytes.length >= 0, `${dir}/${file} 不存在`);
    }
  }
});

test('夹具生成器是确定性的：同一份样本两次生成的字节完全一致（PNG 的 deflate 也要稳定）', async () => {
  const { buildPng, buildZip } = await import('../tools/make-fixtures.mjs');
  const first = buildPng({ size: 16, texts: [{ keyword: 'chara', text: 'e30=' }] });
  const second = buildPng({ size: 16, texts: [{ keyword: 'chara', text: 'e30=' }] });
  assert.deepEqual([...first], [...second]);

  const zipA = buildZip([{ name: 'a.txt', data: 'hello' }]);
  const zipB = buildZip([{ name: 'a.txt', data: 'hello' }]);
  assert.deepEqual([...zipA], [...zipB]);
  assert.equal(zlib.inflateSync(zlib.deflateSync(Buffer.from('x'))).toString(), 'x');
});
