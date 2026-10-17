import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AssetClient } from '../src/data/asset-client.ts';
import {
  SELF_TEST_PNG_BASE64,
  runAssetSelfTest,
  selfTestPngBytes,
  sha256HexOf,
} from '../src/data/asset-selftest.ts';

/**
 * 资产库自检的纯逻辑：用 fake client 覆盖成功与每一步失败。
 * 真机验证由设置页按钮 + adb/Playwright 完成（这里不碰 Tauri/wire）。
 */

function fakeClient(overrides: Partial<AssetClient> = {}): AssetClient {
  const store = new Map<string, Uint8Array>();
  return {
    kind: 'memory',
    available: true,
    persistent: false,
    async put(bytes) {
      const hash = await sha256HexOf(bytes);
      store.set(hash, bytes);
      return hash;
    },
    async get(hash) {
      return store.get(hash);
    },
    async list() {
      return [...store.keys()].sort();
    },
    async remove(hash) {
      return store.delete(hash);
    },
    ...overrides,
  };
}

test('自检样本是有效的 1×1 PNG（不是产品图片）', () => {
  const bytes = selfTestPngBytes();
  assert.ok(bytes.length > 8);
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG 签名');
  assert.equal(Buffer.from(SELF_TEST_PNG_BASE64, 'base64').length, bytes.length);
});

test('成功路径：put → hash → get → list → remove 全通过，且临时资产被删除', async () => {
  const client = fakeClient();
  const results = await runAssetSelfTest(client);
  assert.deepEqual(results.map((result) => result.step), ['put', 'hash', 'get', 'list', 'remove']);
  assert.deepEqual(results.map((result) => result.ok), [true, true, true, true, true]);
  assert.deepEqual(await client.list(), [], '自检资产必须清理掉');
});

test('put 抛错：只停在 put，并带原因', async () => {
  const client = fakeClient({
    put: async () => {
      throw new Error('host unavailable');
    },
  });
  const results = await runAssetSelfTest(client);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.step, 'put');
  assert.equal(results[0]?.ok, false);
  assert.match(results[0]?.detail ?? '', /host unavailable/);
});

test('哈希不一致：停在 hash，不继续 get/list/remove', async () => {
  const client = fakeClient({ put: async () => 'f'.repeat(64) });
  const results = await runAssetSelfTest(client);
  assert.deepEqual(results.map((result) => result.step), ['put', 'hash']);
  assert.equal(results[1]?.ok, false);
});

test('回读缺失/列表缺失/删除失败都各自可定位', async () => {
  const missingGet = fakeClient({ get: async () => undefined });
  const getResults = await runAssetSelfTest(missingGet);
  assert.deepEqual(getResults.map((result) => result.step), ['put', 'hash', 'get']);
  assert.equal(getResults[2]?.ok, false);

  const missingList = fakeClient({ list: async () => [] });
  const listResults = await runAssetSelfTest(missingList);
  assert.deepEqual(listResults.map((result) => result.step), ['put', 'hash', 'get', 'list']);
  assert.equal(listResults[3]?.ok, false);

  const removeFalse = fakeClient({ remove: async () => false });
  const removeResults = await runAssetSelfTest(removeFalse);
  assert.deepEqual(removeResults.map((result) => result.step), ['put', 'hash', 'get', 'list', 'remove']);
  assert.equal(removeResults[4]?.ok, false);
});
