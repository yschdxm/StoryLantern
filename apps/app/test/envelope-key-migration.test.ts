import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGREEMENT_KEY_KEY,
  createWebCryptoKeyWrap,
  curveOfPublicKey,
  loadOrCreateAgreementKeys,
} from '../src/data/sync/envelope.ts';
import type { DeviceStore } from '../src/data/op-ports.ts';

/**
 * 换曲线（X25519 → P-256）之后的**密钥迁移**。
 *
 * 真机踩到的坑：手机的协商密钥是**换 P-256 之前**生成的 X25519；而 `loadOrCreateAgreementKeys`
 * 会"复用已存的密钥"（当时的设计是"已有设备不必重新配钥匙"）。结果：
 *  - 它拿着 X25519 公钥去加入，库主人也确实用 X25519 把它那份包好了；
 *  - 可它自己的 WebView **不认识 X25519**，两种曲线都试也解不开 → 永远认为"我不在共享库里"；
 *  - 于是每次同步都重跑一遍加入流程（宿主请求日志里成片重复的 PROPFIND/GET），界面因此像卡死。
 *
 * 现在的规则：**存过的密钥也要先看这条曲线本机能不能用**；用不了就重新生成（P-256）。
 */

function memoryDevice(): DeviceStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

const LEGACY_X25519_PUBLIC = '11'.repeat(32); // 32 字节 → 旧曲线
const LEGACY_FAKE_PRIVATE = '22'.repeat(48);

test('存的是旧 X25519 密钥、而本机不认识 X25519：必须换成 P-256', async () => {
  const subtle = globalThis.crypto.subtle as unknown as {
    generateKey: (...args: unknown[]) => Promise<unknown>;
  };
  const realGenerateKey = subtle.generateKey.bind(subtle);
  // 伪装成真机：只认识 P-256
  subtle.generateKey = async (algorithm: unknown, ...rest: unknown[]) => {
    if ((algorithm as { name?: string }).name === 'X25519') {
      throw new Error("Failed to execute 'generateKey' on 'SubtleCrypto': Algorithm: Unrecognized name");
    }
    return realGenerateKey(algorithm, ...rest);
  };

  try {
    const device = memoryDevice();
    await device.set(
      AGREEMENT_KEY_KEY,
      JSON.stringify({ v: 1, publicKey: LEGACY_X25519_PUBLIC, privateKey: LEGACY_FAKE_PRIVATE }),
    );

    const key = await loadOrCreateAgreementKeys(createWebCryptoKeyWrap(), device);
    assert.equal(curveOfPublicKey(key.publicKey), 'P-256', '必须换成本机能用的曲线');
    assert.notEqual(key.publicKey, LEGACY_X25519_PUBLIC);
    assert.equal(device.data.has(AGREEMENT_KEY_KEY), true);
    // 存回去的也要是新那把（下次启动才不会再换一遍）
    const stored = JSON.parse(device.data.get(AGREEMENT_KEY_KEY) ?? '{}') as { publicKey?: string };
    assert.equal(stored.publicKey, key.publicKey);
  } finally {
    subtle.generateKey = realGenerateKey;
  }
});

test('存的是能用的密钥：照旧复用（不打乱已有设备）', async () => {
  const device = memoryDevice();
  const first = await loadOrCreateAgreementKeys(createWebCryptoKeyWrap(), device);
  const again = await loadOrCreateAgreementKeys(createWebCryptoKeyWrap(), device);
  assert.equal(again.publicKey, first.publicKey, '同一台设备不该每次换钥匙');
  assert.equal(again.privateKey, first.privateKey);
  assert.equal(curveOfPublicKey(first.publicKey), 'P-256');
});
