#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { HlcClock } from '../packages/oplog/src/hlc.ts';
import { ulid } from '../packages/oplog/src/bytes.ts';
import { encodeOp, messageAppend } from '../packages/oplog/src/op.ts';
import { nodeDigest, nodeGzip, createAesGcmCipher } from '../packages/oplog/src/node-adapters.ts';
import { packSegment, unpackSegment } from '../packages/oplog/src/segment.ts';

/**
 * 段编解码基准：把"压缩与加密的顺序"这件事量成数字，而不是靠感觉。
 *
 * 背景：现在的段是**先加密、后 gzip**（`packSegment` 里 `cipher.seal(...)` 在 `compressor.compress(...)` 之前），
 * 而且密文还套了一层 base64 塞进 JSON。密文不可压缩，于是 gzip 只能把 base64 涨出来的部分压回去一点，
 * 结果压缩比 ≈0.96×（略有变大的意思）。PLAN §11 的预算是段压缩 ≥3×。
 *
 * 这里对比四种方案（**只量编解码这一步**；签名/摘要在各方案里是常量，不掺进来）：
 *   A  现状：seal(明文) → base64 塞 JSON → gzip(整个 JSON)          ← 现在仓库里的实现
 *   B  先压后加密：gzip(明文) → seal(压缩后的字节) → base64 塞 JSON   ← 最小改动的"先压后加密"
 *   B′ 先压后加密 + 二进制拼帧：gzip(明文) → seal → nonce‖密文（去 base64）
 *   C′ 只加密不压缩 + 二进制拼帧：seal(明文) → nonce‖密文
 *   C₀ 只加密不压缩、但仍套 base64（就是"现状去掉 gzip"）            ← 用来证明"去 gzip 必须同时去 base64"
 *
 * 用法：node scripts/measure-segment-codec.mjs [op 条数] [轮数]
 */

const count = Number.parseInt(process.argv[2] ?? '1000', 10);
const rounds = Number.parseInt(process.argv[3] ?? '7', 10);
// 内容模式：repetitive 会让压缩比虚高（同一句话只改个数字）；varied 更接近真实聊天，两个都跑才诚实。
const mode = process.argv[4] ?? 'varied';

// ---- 造真实的 op（真实构造器 + 真实 HLC；文本按 mode 生成） ----
const words = '风 雪 灯 火 门 影子 铜铃 隘口 星 河 旧地图 守夜人 雪线 茶 靴子 沉默 石头 纸 名字 回声'.split(' ');
let seed = 20261015;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const sentence = () => {
  const length = 6 + Math.floor(rand() * 18);
  const picked = [];
  for (let index = 0; index < length; index += 1) picked.push(words[Math.floor(rand() * words.length)]);
  return picked.join('') + '。';
};

const clock = new HlcClock();
const sessionId = ulid();
const ops = [];
for (let index = 0; index < count; index += 1) {
  ops.push(
    messageAppend(
      { deviceId: 'device-a', clock },
      {
        sessionId,
        messageId: ulid(),
        author: index % 2 === 0 ? 'user' : 'character',
        content: mode === 'repetitive' ? `第 ${index + 1} 条：风从北面来，带着雪线的味道。铜铃响的时候，别回头。` : `${sentence()}${sentence()}`,
      },
    ),
  );
}

const ports = { digest: nodeDigest, compressor: nodeGzip, cipher: createAesGcmCipher({ key: new Uint8Array(randomBytes(32)) }) };
const headerLine = JSON.stringify({ magic: 'SFSEG1', v: 1, deviceId: 'device-a', seq: 1, blindSessionId: 'blind', epoch: 0, createdAt: 0, count, codec: 'jsonl' });
const plaintext = ops.map((op) => encodeOp(op)).join('\n');
const plainBytes = new TextEncoder().encode(`${headerLine}\n${plaintext}`);

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
const trailerLine = (count, extra) => new TextEncoder().encode(JSON.stringify({ count, ...extra }));

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

async function timeIt(fn, times = rounds) {
  const samples = [];
  for (let round = 0; round < times; round += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

// ---- A：现状（直接调仓库里的实现，作为基准真相） ----
const packA = () =>
  packSegment({ ops, deviceId: 'device-a', seq: 1, blindSessionId: 'blind', ports, encrypt: true });
const aFirst = await packA();
const aBytes = aFirst.bytes.length;
const aPackMs = await timeIt(packA);
const aUnpackMs = await timeIt(async () => {
  await unpackSegment(aFirst.bytes, { ports });
});

// ---- B：先 gzip 明文 → 再 seal → base64 塞 JSON ----
const packB = async () => {
  const gz = await ports.compressor.compress(plainBytes);
  const sealed = await ports.cipher.seal(gz, new TextEncoder().encode(headerLine));
  const body = new TextEncoder().encode(JSON.stringify({ nonce: b64(sealed.nonce), ct: b64(sealed.ciphertext) }));
  const trailer = trailerLine(count, { compression: 'gzip', cipher: 'aes-256-gcm' });
  return concat(body, new Uint8Array([0x0a]), trailer);
};
const packBU = async (bytes) => {
  const text = new TextDecoder().decode(bytes);
  const body = JSON.parse(text.slice(0, text.indexOf('\n')));
  return ports.compressor.decompress(await ports.cipher.open(new Uint8Array(Buffer.from(body.nonce, 'base64')), new Uint8Array(Buffer.from(body.ct, 'base64')), new TextEncoder().encode(headerLine)));
};
const bFirst = await packB();
const bPackMs = await timeIt(packB);
const bUnpackMs = await timeIt(() => packBU(bFirst));
const bRoundTrip = new TextDecoder().decode(await packBU(bFirst)) === new TextDecoder().decode(plainBytes);

// ---- B′：先 gzip → 再 seal → 二进制拼帧（nonce‖密文，无 base64） ----
const packB2 = async () => {
  const gz = await ports.compressor.compress(plainBytes);
  const sealed = await ports.cipher.seal(gz, new TextEncoder().encode(headerLine));
  return concat(new Uint8Array([12]), sealed.nonce, sealed.ciphertext, new Uint8Array([0x0a]), trailerLine(count, { compression: 'gzip', cipher: 'aes-256-gcm', nonceLen: 12 }));
};
const packB2U = async (bytes) => {
  const nonceLen = bytes[0];
  const nonce = bytes.subarray(1, 1 + nonceLen);
  // trailer 是最后一整行（与仓库里段的实际布局一致：压缩体 ++ "\n" ++ trailer）
  const ct = bytes.subarray(1 + nonceLen, bytes.lastIndexOf(0x0a));
  return ports.compressor.decompress(await ports.cipher.open(new Uint8Array(nonce), new Uint8Array(ct), new TextEncoder().encode(headerLine)));
};
const b2First = await packB2();
const b2PackMs = await timeIt(packB2);
const b2UnpackMs = await timeIt(() => packB2U(b2First));
const b2RoundTrip = new TextDecoder().decode(await packB2U(b2First)) === new TextDecoder().decode(plainBytes);

// ---- C′：只加密（无压缩）+ 二进制拼帧 ----
const packC = async () => {
  const sealed = await ports.cipher.seal(plainBytes, new TextEncoder().encode(headerLine));
  return concat(new Uint8Array([12]), sealed.nonce, sealed.ciphertext, new Uint8Array([0x0a]), trailerLine(count, { compression: 'none', cipher: 'aes-256-gcm', nonceLen: 12 }));
};
const cFirst = await packC();
const cPackMs = await timeIt(packC);

// ---- C₀：只加密、仍套 base64（现状去掉 gzip） ----
const packC0 = async () => {
  const sealed = await ports.cipher.seal(plainBytes, new TextEncoder().encode(headerLine));
  const body = new TextEncoder().encode(JSON.stringify({ nonce: b64(sealed.nonce), ct: b64(sealed.ciphertext) }));
  return concat(body, new Uint8Array([0x0a]), trailerLine(count, { compression: 'none', cipher: 'aes-256-gcm' }));
};
const c0First = await packC0();

// ---- 原语成本（谁贵谁便宜，一目了然） ----
const sealPlainMs = await timeIt(async () => ports.cipher.seal(plainBytes, new TextEncoder().encode(headerLine)), rounds * 3);
const gzipPlainMs = await timeIt(() => ports.compressor.compress(plainBytes), rounds * 3);
const gzipCipherMs = await timeIt(async () => {
  const sealed = await ports.cipher.seal(plainBytes, new TextEncoder().encode(headerLine));
  return ports.compressor.compress(new TextEncoder().encode(JSON.stringify({ nonce: b64(sealed.nonce), ct: b64(sealed.ciphertext) })));
}, rounds * 3);

const rows = [
  { name: 'A  现状：seal→base64→gzip', bytes: aBytes, pack: aPackMs, unpack: aUnpackMs, ok: '仓库原实现' },
  { name: 'B  gzip→seal→base64', bytes: bFirst.length, pack: bPackMs, unpack: bUnpackMs, ok: bRoundTrip ? '往返一致' : '往返不一致 ✗' },
  { name: "B′ gzip→seal→二进制拼帧", bytes: b2First.length, pack: b2PackMs, unpack: b2UnpackMs, ok: b2RoundTrip ? '往返一致' : '往返不一致 ✗' },
  { name: "C′ 只加密→二进制拼帧", bytes: cFirst.length, pack: cPackMs, unpack: Number.NaN, ok: '未测解包' },
  { name: 'C₀ 只加密→base64', bytes: c0First.length, pack: Number.NaN, unpack: Number.NaN, ok: '仅量字节' },
];

console.log(`\n内容模式 ${mode}；op 条数 ${count}；明文（头部+JSONL）${plainBytes.length} B；每项取 ${rounds} 轮中位数\n`);
console.log('  方案                          字节数   占明文   压缩比   打包 ms   解包 ms');
for (const row of rows) {
  const ratio = plainBytes.length / row.bytes;
  const pack = Number.isNaN(row.pack) ? '   —' : (row.pack.toFixed(1) + ' ms').padStart(8);
  const unpack = Number.isNaN(row.unpack) ? '   —' : (row.unpack.toFixed(1) + ' ms').padStart(8);
  console.log(
    `  ${row.name.padEnd(28)} ${String(row.bytes).padStart(8)}  ${(row.bytes / plainBytes.length).toFixed(2)}×   ${ratio.toFixed(2)}×  ${pack}  ${unpack}`,
  );
}
console.log('\n  往返校验：' + rows.map((row) => `${row.name.slice(0, 2).trim()}=${row.ok}`).join('，'));
console.log(`\n  原语成本（同数据）：seal(明文) ${sealPlainMs.toFixed(1)} ms；gzip(明文) ${gzipPlainMs.toFixed(1)} ms；gzip(密文 JSON) ${gzipCipherMs.toFixed(1)} ms`);
console.log('  注：签名与 sha256 在各方案里是同一份工作量，未计入"打包 ms"（那些是常量，不影响方案对比）。\n');
