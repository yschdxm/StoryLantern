import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureKeyring } from '../../../packages/sync-core/src/keyring-store.ts';
import { KEYRING_FILE } from '../../../packages/sync-core/src/keyring.ts';
import { createWebCryptoKeyWrap } from '../src/data/sync/envelope.ts';
import type { SyncBackend, BackendEntry, ListResult, PutResult } from '../../../packages/sync-core/src/backend.ts';

/**
 * **读不到钥匙包 ≠ 还没有钥匙包**。
 *
 * 真机踩到的事故：MuMu 的 WebView 读共享目录失败（别的东西也读不到），
 * 而 `ensureKeyring` 把"读失败"和"还没建过"当成同一件事 → 本机**悄悄自立为库主人**，
 * 既不写加入请求、也不报任何错，界面上还显示「完成：上传 1 段」。
 * 于是用户以为已经加入，实际什么都没发生。
 *
 * 现在只有**确实不存在**（404 之类）才算"要新建"；其余错误必须抛出去，让同步**明确失败**。
 */

function backendWhereKeyringGetFails(message: string): SyncBackend {
  const files = new Map<string, Uint8Array>();
  return {
    id: 'test',
    capabilities: { conditionalPut: true, rangeRead: true, delete: true, listPagination: false, watch: false },
    async list(prefix: string): Promise<ListResult> {
      const entries: BackendEntry[] = [...files.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, bytes]) => ({ path, size: bytes.length }));
      return { entries };
    },
    async get(path: string): Promise<Uint8Array> {
      if (path === KEYRING_FILE) throw new Error(message);
      throw new Error(`404 找不到 ${path}`);
    },
    async put(path: string, bytes: Uint8Array): Promise<PutResult> {
      files.set(path, bytes);
      return { ok: true };
    },
  };
}

test('读钥匙包失败（不是 404）必须抛出，不能悄悄自立为库主人', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const agreement = await keyWrap.generateAgreementKeys();
  await assert.rejects(
    () =>
      ensureKeyring({
        backend: backendWhereKeyringGetFails('WebDAV 503：暂时不可用'),
        deviceId: 'self',
        agreement,
        keyWrap,
        peerAgreementKeys: {},
      }),
    /503/,
  );
});

test('确实还没有钥匙包（404）时照旧新建，不算失败', async () => {
  const keyWrap = createWebCryptoKeyWrap();
  const agreement = await keyWrap.generateAgreementKeys();
  const backend = backendWhereKeyringGetFails('404 找不到 keyring.json');
  const result = await ensureKeyring({
    backend,
    deviceId: 'self',
    agreement,
    keyWrap,
    peerAgreementKeys: {},
  });
  assert.equal(result.mine, true, '新库的主人就是本机');
  assert.equal(result.epoch, 1);
});
