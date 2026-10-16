import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HlcClock } from '../src/hlc.ts';
import { encodeOp, messageAppend } from '../src/op.ts';
import { nodeDigest, nodeGzip, createAesGcmCipher, createDeviceSigner, generateDeviceKeyPair, createRosterVerifier } from '../src/node-adapters.ts';
import { packSegment, unpackSegment, peekSegment, SEGMENT_FORMAT_VERSION } from '../src/segment.ts';

/**
 * v2 段格式：**先压缩、再加密**，密文用二进制拼帧（不再套 base64）。
 *
 * 为什么换（都有实测）：v1 是"先加密再 gzip"，gzip 面对密文压不动（实测 1.00×），
 * 密文又被 base64 撑大 33% → 现状是"零压缩 + 五套方案里最慢"。v2 的实测压缩比 9-24×，
 * 打包快约 4.7 倍、解包快约 18 倍（见 scripts/measure-segment-codec.mjs 与 DEVELOPMENT.md）。
 *
 * 本文件钉住四件事：v2 往返一致、压缩比达标（PLAN §11 的 ≥3×）、**老段（v1）仍读得出来**、peek 照常。
 */

const key = new Uint8Array(32).fill(7);
const ports = { digest: nodeDigest, compressor: nodeGzip, cipher: createAesGcmCipher({ key }) };
const words = '风 雪 灯 火 门 影子 铜铃 隘口 星 河 旧地图 守夜人 雪线 茶 靴子 沉默 石头'.split(' ');
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const varied = () => Array.from({ length: 8 + Math.floor(rand() * 20) }, () => words[Math.floor(rand() * words.length)]).join('');

const makeOps = (count: number) => {
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  return Array.from({ length: count }, (_, index) =>
    messageAppend(
      { deviceId: 'device-v2', clock },
      { sessionId: 'S1', messageId: `M${index}`, author: index % 2 === 0 ? 'user' : 'character', content: varied() },
    ),
  );
};

test('v2：往返一致，且压缩比达到 PLAN 的 ≥3×', async () => {
  const ops = makeOps(500);
  const packed = await packSegment({ ops, deviceId: 'device-v2', seq: 1, blindSessionId: 'b'.repeat(32), ports, encrypt: true });
  assert.equal(packed.header.v, SEGMENT_FORMAT_VERSION);
  assert.equal(packed.trailer.v, 2, 'v2 的 trailer 必须自报版本（读方据此分叉）');

  // 分母用真实的 op 行（encodeOp 的规范 JSON），别用 JSON.stringify 凑近似
  const plainBytes = new TextEncoder().encode(ops.map((op) => encodeOp(op)).join('\n')).length;
  const ratio = plainBytes / packed.bytes.length;
  console.log(`  [v2 段] ${ops.length} 条 op：明文约 ${plainBytes} B → 段 ${packed.bytes.length} B，压缩比 ${ratio.toFixed(2)}×`);
  assert.ok(ratio >= 3, `压缩比应当 ≥3×（PLAN §11），实际 ${ratio.toFixed(2)}×`);

  const unpacked = await unpackSegment(packed.bytes, { ports, fileName: packed.name });
  assert.equal(unpacked.ops.length, ops.length);
  assert.equal(unpacked.header.v, SEGMENT_FORMAT_VERSION);
  assert.equal((unpacked.ops[499]?.payload as { content: string }).content, (ops[499]?.payload as { content: string }).content);
});

test('v2：peek 不解密也能读到 trailer（条数/摘要）', async () => {
  const ops = makeOps(20);
  const packed = await packSegment({ ops, deviceId: 'device-v2', seq: 3, blindSessionId: 'b'.repeat(32), ports, encrypt: true });
  const peeked = peekSegment(packed.bytes);
  assert.equal(peeked.trailer.count, 20);
  assert.equal(peeked.trailer.v, 2);
  assert.equal(peeked.trailer.blobHash, packed.blobHash);
});

test('v1 老段仍然读得出来（迁移期必须双读）', async () => {
  const ops = makeOps(30);
  const legacy = await packSegment({ ops, deviceId: 'device-v2', seq: 1, blindSessionId: 'b'.repeat(32), ports, encrypt: true, format: 1 });
  assert.equal(legacy.trailer.v, undefined, 'v1 的 trailer 不该有 v 字段（这正是读方识别老段的方式）');
  assert.equal(legacy.header.v, 1);

  const unpacked = await unpackSegment(legacy.bytes, { ports, fileName: legacy.name });
  assert.equal(unpacked.ops.length, 30);
  assert.equal((unpacked.ops[7]?.payload as { content: string }).content, (ops[7]?.payload as { content: string }).content);
});

test('v2：没有密钥时拒绝（先解密后验签），且错误是"解密"这一类', async () => {
  const ops = makeOps(5);
  const packed = await packSegment({ ops, deviceId: 'device-v2', seq: 1, blindSessionId: 'b'.repeat(32), ports, encrypt: true });
  const wrong = { digest: nodeDigest, compressor: nodeGzip, cipher: createAesGcmCipher({ key: new Uint8Array(32).fill(9) }) };
  await assert.rejects(unpackSegment(packed.bytes, { ports: wrong, fileName: packed.name }), /decrypt|解密/);
});

test('v2：签名覆盖段头与内容哈希，换签名者就验不过', async () => {
  const signer = createDeviceSigner(generateDeviceKeyPair('device-v2'));
  const other = createDeviceKeyPairForTest();
  const ops = makeOps(5);
  const packed = await packSegment({ ops, deviceId: 'device-v2', seq: 1, blindSessionId: 'b'.repeat(32), ports: { ...ports, signer }, encrypt: true });
  const verify = createRosterVerifier(new Map([['device-v2', other.publicKeyPem]]));
  await assert.rejects(
    unpackSegment(packed.bytes, { ports: { ...ports, verifier: verify }, fileName: packed.name }),
    /signature|签名/,
  );
});

function createDeviceKeyPairForTest() {
  return generateDeviceKeyPair('someone-else');
}
