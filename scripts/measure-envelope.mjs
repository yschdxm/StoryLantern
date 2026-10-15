#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { HlcClock } from '../packages/oplog/src/hlc.ts';
import { ulid } from '../packages/oplog/src/bytes.ts';
import { messageAppend } from '../packages/oplog/src/op.ts';
import { Materializer } from '../packages/oplog/src/materialize.ts';
import { nodeDigest, nodeGzip, createAesGcmCipher } from '../packages/oplog/src/node-adapters.ts';
import { encodeEnvelope } from '../packages/sync-core/src/envelope.ts';

/**
 * 信封（manifest 与 snapshot 共用的那套）基准。
 *
 * 背景：`packages/sync-core/src/envelope.ts` 的顺序是 **先 seal 加密 → 密文 base64 塞进 JSON → 最后才 gzip 整个 JSON**，
 * 和段格式 v1 的毛病一样：密文被 base64 撑大 33%，gzip 又只能把 base64 涨出来的部分压回去一点，
 * 而真正的内容几乎没被压缩。manifest 小、影响有限；**快照可以很大**，所以这里用一份真实规模的快照体来量。
 *
 * 用法：node scripts/measure-envelope.mjs [消息条数] [轮数]
 */

const count = Number.parseInt(process.argv[2] ?? '10000', 10);
const rounds = Number.parseInt(process.argv[3] ?? '5', 10);

// ---- 造一份"真实规模"的快照体：1 万条消息的物化状态序列化 ----
const clock = new HlcClock();
const sessionId = ulid();
const words = '风 雪 灯 火 门 影子 铜铃 隘口 星 河 旧地图 守夜人 雪线 茶 靴子 沉默 石头 纸 名字 回声'.split(' ');
let seed = 424242;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const sentence = () => Array.from({ length: 6 + Math.floor(rand() * 16) }, () => words[Math.floor(rand() * words.length)]).join('') + '。';

const materializer = new Materializer();
for (let index = 0; index < count; index += 1) {
  materializer.apply(
    messageAppend(
      { deviceId: 'device-a', clock },
      { sessionId, messageId: ulid(), author: index % 2 === 0 ? 'user' : 'character', content: `${sentence()}${sentence()}` },
    ),
  );
}
const inner = JSON.stringify(materializer.state);
const innerBytes = new TextEncoder().encode(inner);

const ports = { digest: nodeDigest, compressor: nodeGzip, cipher: createAesGcmCipher({ key: new Uint8Array(randomBytes(32)) }) };
const aad = 'snapshot|demo';
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;

async function timeIt(fn) {
  const samples = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

// A：现状（encodeEnvelope：encrypt → base64 → JSON → gzip）
const aEncode = () => encodeEnvelope(inner, { ports, encrypt: true, aad });
const aBytes = (await aEncode()).length;
const aMs = await timeIt(aEncode);

// B：先 gzip → 再 seal → 二进制拼帧（[nonceLen][nonce][密文]）
const bEncode = async () => {
  const compressed = await ports.compressor.compress(innerBytes);
  const sealed = await ports.cipher.seal(compressed, new TextEncoder().encode(aad));
  return concat(new Uint8Array([12]), sealed.nonce, sealed.ciphertext);
};
const bBytes = (await bEncode()).length;
const bMs = await timeIt(bEncode);

// C：只 seal（不压缩）→ 二进制拼帧
const cEncode = async () => {
  const sealed = await ports.cipher.seal(innerBytes, new TextEncoder().encode(aad));
  return concat(new Uint8Array([12]), sealed.nonce, sealed.ciphertext);
};
const cBytes = (await cEncode()).length;
const cMs = await timeIt(cEncode);

// D：只 gzip（不加密）—— 作为"内容本身能压多少"的参照
const dBytes = (await ports.compressor.compress(innerBytes)).length;

console.log(`\n快照体：${count} 条消息的物化状态，${innerBytes.length} B；每项 ${rounds} 轮中位数\n`);
console.log('  方案                                    字节数   占原文   压缩比   耗时 ms');
const rows = [
  { name: 'A 现状：encrypt→base64→JSON→gzip', bytes: aBytes, ms: aMs },
  { name: 'B 先 gzip→seal→二进制拼帧', bytes: bBytes, ms: bMs },
  { name: 'C 只 seal→二进制拼帧', bytes: cBytes, ms: cMs },
  { name: 'D 只 gzip（参照，无加密）', bytes: dBytes, ms: Number.NaN },
];
for (const row of rows) {
  const ms = Number.isNaN(row.ms) ? '   —' : row.ms.toFixed(1).padStart(6);
  console.log(
    `  ${row.name.padEnd(38)} ${String(row.bytes).padStart(8)}  ${(row.bytes / innerBytes.length).toFixed(2)}×   ${(innerBytes.length / row.bytes).toFixed(2)}×  ${ms}`,
  );
}
console.log('');
