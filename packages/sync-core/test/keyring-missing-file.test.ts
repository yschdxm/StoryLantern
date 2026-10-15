import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureKeyring } from '../src/keyring-store.ts';
import { describeError } from '../src/error-text.ts';
import { KEYRING_FILE, parseKeyring } from '../src/keyring.ts';
import { createWebCryptoKeyWrap } from '../../../apps/app/src/data/sync/envelope.ts';
import type { SyncBackend } from '../src/backend.ts';

/**
 * "空目录里还没有 keyring"这条最基本的路 —— 真机上刚刚被它打挂。
 *
 * 事故：模拟器把同步方式切到"本地文件夹"、用 SAF 选了一个**空**的 Documents 目录，
 * 第一次同步就失败在「文件不存在： keyring.json」。原因不是 SAF，而是 `ensureKeyring` 里
 * 判断"读不到 = 还没有"用的是
 * `cause instanceof Error ? cause.message : String(cause)`——
 * **Tauri/SAF 拒绝时抛的是普通对象**，于是 message 变成 `[object Object]`，
 * "不存在"这条正则永远匹配不上，于是它把"还没有钥匙包"当成硬错误抛了出去。
 *
 * 所以这里把那个形状原样钉住：**普通对象**形式的"文件不存在"必须被当成"还没有"。
 */

function backendWithMissingKeyring(error: unknown, writes: string[]): SyncBackend {
  return {
    id: 'test-empty-folder',
    capabilities: { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false },
    async list() {
      return { entries: [] };
    },
    async get(path: string): Promise<Uint8Array> {
      if (path === KEYRING_FILE) throw error;
      throw new Error(`not-found ${path}`);
    },
    async put(path: string, bytes: Uint8Array) {
      writes.push(path);
      return { ok: true, bytes };
    },
  } as SyncBackend;
}

test('空目录：keyring.json 不存在（且抛的是**普通对象**）→ 必须当成"还没有"并建库', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const mine = await keyWrap.generateAgreementKeys();
  const writes: string[] = [];
  const backend = backendWithMissingKeyring({ message: '文件不存在： keyring.json' }, writes);

  const result = await ensureKeyring({
    backend,
    deviceId: 'me',
    agreement: mine,
    keyWrap,
    peerAgreementKeys: {},
  });

  assert.equal(result.mine, true, '空目录里就该由本机建库');
  assert.equal(result.epoch, 1);
  assert.deepEqual(writes, [KEYRING_FILE], '建好的钥匙包要真的写下去');
});

test('空目录：抛的是 Error（也就带 message）时同样当成"还没有"', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const mine = await keyWrap.generateAgreementKeys();
  const writes: string[] = [];
  const backend = backendWithMissingKeyring(new Error('404 not found: keyring.json'), writes);

  const result = await ensureKeyring({ backend, deviceId: 'me', agreement: mine, keyWrap, peerAgreementKeys: {} });
  assert.equal(result.mine, true);
  assert.equal(writes.length, 1);
});

test('真正的错误（权限/网络）仍然必须抛出去——绝不静默自立为库主人', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const mine = await keyWrap.generateAgreementKeys();
  const writes: string[] = [];
  const backend = backendWithMissingKeyring({ message: '权限不足：无法读取共享目录' }, writes);

  // 注意：这里抛出来的可能是**普通对象**（Tauri 就是这样），所以不能拿正则去匹配 rejection，
  // 而应当按"界面实际会怎么显示"来断言——界面统一用 describeError 把它变成人话。
  await assert.rejects(
    () => ensureKeyring({ backend, deviceId: 'me', agreement: mine, keyWrap, peerAgreementKeys: {} }),
    (cause: unknown) => {
      assert.match(describeError(cause), /权限不足/, '不是"不存在"的错误必须原样抛出');
      return true;
    },
  );
  assert.deepEqual(writes, [], '抛错时绝不能写钥匙包');
});

test('读回一个坏文件（不是 JSON）：也不能当成"还没有"', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const mine = await keyWrap.generateAgreementKeys();
  const writes: string[] = [];
  const backend = backendWithMissingKeyring(new Error('不是合法 JSON'), writes);

  await assert.rejects(
    () => ensureKeyring({ backend, deviceId: 'me', agreement: mine, keyWrap, peerAgreementKeys: {} }),
    /不是合法 JSON/,
  );
  assert.deepEqual(writes, []);
});

// 顺手确认一下 parseKeyring 的存在（这组测试只用到常量与它，避免"测试里引用没用到的东西"）
test('KEYRING_FILE 就是同步目录里的 keyring.json', () => {
  assert.equal(KEYRING_FILE, 'keyring.json');
  assert.throws(() => parseKeyring('不是 JSON'));
});
