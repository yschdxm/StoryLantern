import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssetStore } from '../src/asset.ts';
import { createAesGcmCipher, nodeDigest, nodeGzip } from '../../oplog/src/node-adapters.ts';
import type { CryptoPorts } from '../../oplog/src/ports.ts';
import { createMemoryBackend } from '../../../plugins/sync-memory/src/index.ts';

function ports(withCipher: boolean): CryptoPorts {
  const base: CryptoPorts = { digest: nodeDigest, compressor: nodeGzip };
  return withCipher ? { ...base, cipher: createAesGcmCipher({ key: new Uint8Array(32).fill(3) }) } : base;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

test('资产：上传 → 下载往返一致，且哈希稳定（同内容同哈希）', async () => {
  const store = createAssetStore({ backend: createMemoryBackend(), ports: ports(false) });

  const first = await store.put(PNG);
  assert.equal(first.uploaded, true);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.equal(first.bytes, PNG.length + 2, '未加密时只多 2 字节帧头');

  const second = await store.put(PNG);
  assert.equal(second.hash, first.hash);
  assert.equal(second.uploaded, false, '同内容第二次上传应因条件写返回"已存在"');

  assert.deepEqual([...((await store.get(first.hash)) as Uint8Array)], [...PNG]);
  assert.equal(await store.has(first.hash), true);
  assert.equal(await store.has('0'.repeat(64)), false);
});

test('资产加密：落盘字节不含明文，错误密钥无法解密', async () => {
  const backend = createMemoryBackend();
  const store = createAssetStore({ backend, ports: ports(true) });
  const secret = new TextEncoder().encode('这是一张立绘的字节内容，绝不该在远端出现');

  const { hash } = await store.put(secret);
  const stored = backend.files.get(`assets/${hash}`);
  assert.ok(stored, '文件应存放在 assets/<hash>');

  const asText = Buffer.from(stored).toString('latin1');
  assert.equal(asText.includes('立绘'), false, '密文里不得出现明文');

  assert.deepEqual([...(await store.get(hash))], [...secret]);

  // 换一把密钥：必须明确失败，绝不返回部分明文
  const wrongKey = createAssetStore({
    backend,
    ports: { digest: nodeDigest, compressor: nodeGzip, cipher: createAesGcmCipher({ key: new Uint8Array(32).fill(9) }) },
  });
  await assert.rejects(() => wrongKey.get(hash), /解密失败/);
});

test('资产被篡改：认证标签校验失败即拒绝', async () => {
  const backend = createMemoryBackend();
  const store = createAssetStore({ backend, ports: ports(true) });
  const { hash } = await store.put(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

  const path = `assets/${hash}`;
  const tampered = Uint8Array.from(backend.files.get(path) as Uint8Array);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0xff;
  backend.seed(path, tampered);

  await assert.rejects(() => store.get(hash), /解密失败/);
});

test('资产帧损坏 / 版本不受支持都必须明确报错', async () => {
  const backend = createMemoryBackend();
  const store = createAssetStore({ backend, ports: ports(false) });

  backend.seed('assets/' + 'a'.repeat(64), new Uint8Array([1]));
  await assert.rejects(() => store.get('a'.repeat(64)), /帧头不完整/);

  backend.seed('assets/' + 'b'.repeat(64), new Uint8Array([9, 0, 1, 2]));
  await assert.rejects(() => store.get('b'.repeat(64)), /不支持的帧版本/);

  backend.seed('assets/' + 'c'.repeat(64), new Uint8Array([1, 7, 1, 2]));
  await assert.rejects(() => store.get('c'.repeat(64)), /未知算法/);
});
