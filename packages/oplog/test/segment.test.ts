import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromHex, toHex } from '../src/bytes.ts';
import { HlcClock } from '../src/hlc.ts';
import { messageAppend, type Op } from '../src/op.ts';
import {
  createAesGcmCipher,
  createDeviceSigner,
  createRosterVerifier,
  generateDeviceKeyPair,
  nodeDigest,
  nodeGzip,
  type DeviceKeyPair,
} from '../src/node-adapters.ts';
import type { CryptoPorts, SegmentCipher } from '../src/ports.ts';
import {
  packSegment,
  parseSegmentFileName,
  peekSegment,
  segmentFileName,
  SEGMENT_POLICY,
  SegmentError,
  shouldFlush,
  unpackSegment,
  type SegmentErrorCode,
} from '../src/segment.ts';

interface TestDevice {
  keys: DeviceKeyPair;
  roster: Map<string, string>;
}

function makeDevice(deviceId: string, roster: Map<string, string>): TestDevice {
  const keys = generateDeviceKeyPair(deviceId);
  roster.set(deviceId, keys.publicKeyPem);
  return { keys, roster };
}

function portsFor(device: TestDevice, cipher?: SegmentCipher): CryptoPorts {
  return {
    digest: nodeDigest,
    compressor: nodeGzip,
    signer: createDeviceSigner(device.keys),
    verifier: createRosterVerifier(device.roster),
    ...(cipher === undefined ? {} : { cipher }),
  };
}

function makeOps(count: number, deviceId: string, prefix = '消息'): Op[] {
  const clock = new HlcClock({ now: () => 1_700_000_000_000 });
  return Array.from({ length: count }, (_, index) =>
    messageAppend(
      { deviceId, clock },
      {
        sessionId: '01SESSION',
        messageId: `01MSG${String(index).padStart(6, '0')}`,
        author: index % 2 === 0 ? 'user' : 'character',
        content: `${prefix}${index}：旅人推开酒馆的门，风把灯火吹得摇晃。`,
      },
    ),
  );
}

async function expectCode(promise: Promise<unknown>, code: SegmentErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SegmentError, `期望 SegmentError，实际 ${String(error)}`);
    assert.equal(error.code, code, `期望错误码 ${code}，实际 ${error.code}（${error.message}）`);
    return true;
  });
}

test('打包 → 解包：内容一致、文件名含序号与字节摘要', async () => {
  const roster = new Map<string, string>();
  const device = makeDevice('01DEV-A', roster);
  const ports = portsFor(device);
  const ops = makeOps(3, '01DEV-A');

  const packed = await packSegment({ ops, deviceId: '01DEV-A', seq: 7, blindSessionId: 'a'.repeat(32), ports });

  assert.equal(packed.name, segmentFileName(7, packed.blobHash));
  assert.match(packed.name, /^00000007-[0-9a-f]{8}\.jsonl\.gz$/);
  assert.equal(parseSegmentFileName(packed.name)?.seq, 7);
  assert.equal(packed.header.count, 3);

  const unpacked = await unpackSegment(packed.bytes, { ports, fileName: packed.name });
  assert.equal(unpacked.ops.length, 3);
  assert.deepEqual(unpacked.ops.map((op) => op.opId), ops.map((op) => op.opId));
  assert.equal(unpacked.blobHash, packed.blobHash);
});

test('不解压即可读到 trailer 与设备身份（廉价预检）', async () => {
  const roster = new Map<string, string>();
  const device = makeDevice('01DEV-A', roster);
  const ports = portsFor(device);
  const packed = await packSegment({ ops: makeOps(2, '01DEV-A'), deviceId: '01DEV-A', seq: 1, blindSessionId: 'b'.repeat(32), ports });

  const peeked = peekSegment(packed.bytes);
  assert.equal(peeked.trailer.count, 2);
  assert.equal(peeked.trailer.blobHash, packed.blobHash);
  assert.ok(peeked.blobBytes > 0);
});

test('半上传 / 传输损坏：crc 不符即整体拒绝', async () => {
  const roster = new Map<string, string>();
  const device = makeDevice('01DEV-A', roster);
  const ports = portsFor(device);
  const packed = await packSegment({ ops: makeOps(5, '01DEV-A'), deviceId: '01DEV-A', seq: 2, blindSessionId: 'c'.repeat(32), ports });

  const corrupted = Uint8Array.from(packed.bytes);
  corrupted[10] = (corrupted[10] as number) ^ 0xff;
  await expectCode(unpackSegment(corrupted, { ports, fileName: packed.name }), 'crc-mismatch');

  // 直接砍掉 trailer（典型"上传到一半"）
  let lastNewline = packed.bytes.length - 1;
  while (lastNewline >= 0 && packed.bytes[lastNewline] !== 0x0a) lastNewline -= 1;
  const truncated = packed.bytes.subarray(0, lastNewline);
  await expectCode(unpackSegment(truncated, { ports }), 'truncated');
});

test('张冠李戴：文件名摘要与实收字节不符时拒绝', async () => {
  const roster = new Map<string, string>();
  const device = makeDevice('01DEV-A', roster);
  const ports = portsFor(device);
  const packed = await packSegment({ ops: makeOps(2, '01DEV-A'), deviceId: '01DEV-A', seq: 3, blindSessionId: 'd'.repeat(32), ports });

  await expectCode(
    unpackSegment(packed.bytes, { ports, fileName: '00000003-deadbeef.jsonl.gz' }),
    'name-mismatch',
  );
});

test('名单外设备 / 无签名的段一律拒绝（哑存储上可信度的唯一来源）', async () => {
  const roster = new Map<string, string>();
  const device = makeDevice('01DEV-A', roster);
  const attackerPorts: CryptoPorts = { digest: nodeDigest, compressor: nodeGzip };
  const ops = makeOps(2, '01DEV-A');

  // 攻击者能重算 crc/哈希/文件名，但没有私钥
  const forged = await packSegment({ ops, deviceId: '01DEV-A', seq: 4, blindSessionId: 'e'.repeat(32), ports: attackerPorts });
  await expectCode(
    unpackSegment(forged.bytes, { ports: portsFor(device), fileName: forged.name }),
    'signature',
  );

  // 合法签名的段，但验证方名单里没有这台设备
  const packed = await packSegment({ ops, deviceId: '01DEV-A', seq: 5, blindSessionId: 'e'.repeat(32), ports: portsFor(device) });
  const emptyRoster: CryptoPorts = {
    digest: nodeDigest,
    compressor: nodeGzip,
    verifier: createRosterVerifier(new Map()),
  };
  await expectCode(unpackSegment(packed.bytes, { ports: emptyRoster, fileName: packed.name }), 'signature');
});

test('段内容被替换：攻击者只能做到"自洽"，无法伪签名', async () => {
  const roster = new Map<string, string>();
  const device = makeDevice('01DEV-A', roster);
  const ports = portsFor(device);
  const ops = makeOps(2, '01DEV-A');

  const legit = await packSegment({ ops, deviceId: '01DEV-A', seq: 6, blindSessionId: 'f'.repeat(32), ports });

  // 攻击者解压 → 改正文 → 重新打包（crc/哈希/文件名都能算对），但没有私钥
  const tamperedOps = ops.map((op) => ({
    ...op,
    payload: { ...(op.payload as Record<string, unknown>), content: '被篡改的内容' },
  }));
  const forged = await packSegment({
    ops: tamperedOps,
    deviceId: '01DEV-A',
    seq: 6,
    blindSessionId: 'f'.repeat(32),
    ports: { digest: nodeDigest, compressor: nodeGzip },
  });

  assert.notEqual(forged.blobHash, legit.blobHash);
  await expectCode(unpackSegment(forged.bytes, { ports, fileName: forged.name }), 'signature');
});

test('端到端加密：正确密钥可读，错误密钥明确失败（绝不返回部分明文）', async () => {
  const roster = new Map<string, string>();
  const device = makeDevice('01DEV-A', roster);
  const cipher = createAesGcmCipher({ key: fromHex('a1'.repeat(32)) });
  const ports = portsFor(device, cipher);

  const ops = makeOps(3, '01DEV-A');
  const packed = await packSegment({
    ops,
    deviceId: '01DEV-A',
    seq: 8,
    blindSessionId: '1'.repeat(32),
    ports,
    encrypt: true,
  });
  assert.equal(packed.header.cipher, 'aes-256-gcm');

  // 密文段里不应该出现明文内容
  const asText = Buffer.from(packed.bytes).toString('latin1');
  assert.equal(asText.includes('旅人推开酒馆的门'), false);

  const unpacked = await unpackSegment(packed.bytes, { ports, fileName: packed.name });
  assert.equal(unpacked.ops.length, 3);

  const wrongKey = createAesGcmCipher({ key: fromHex('b2'.repeat(32)) });
  await expectCode(
    unpackSegment(packed.bytes, { ports: portsFor(device, wrongKey), fileName: packed.name }),
    'decrypt',
  );
});

test('段的体积有上界：压缩有效，且分段阈值可判定', async () => {
  const roster = new Map<string, string>();
  const device = makeDevice('01DEV-A', roster);
  const ports = portsFor(device);
  const ops = makeOps(800, '01DEV-A');

  const rawBytes = new TextEncoder().encode(ops.map((op) => JSON.stringify(op)).join('\n'));
  const packed = await packSegment({ ops, deviceId: '01DEV-A', seq: 9, blindSessionId: '2'.repeat(32), ports });

  assert.equal(packed.header.count, 800);
  assert.ok(packed.bytes.length < rawBytes.length, `压缩后应更小（${packed.bytes.length} vs ${rawBytes.length}）`);
  const ratio = rawBytes.length / packed.bytes.length;
  assert.ok(ratio > 2, `压缩比应 > 2（实际 ${ratio.toFixed(2)}）`);

  assert.equal(shouldFlush(0, 0), false);
  assert.equal(shouldFlush(0, SEGMENT_POLICY.maxOps), true);
  assert.equal(shouldFlush(SEGMENT_POLICY.targetBytes, 1), true);
  assert.equal(shouldFlush(0, 1, true), true);
  assert.equal(toHex(nodeDigest.sha256(new Uint8Array([1, 2, 3])) as Uint8Array).length, 64);
});
