import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyring, openKeyring, parseKeyring, serializeKeyring } from '../../../packages/sync-core/src/keyring.ts';
import { AGREEMENT_KEY_KEY, createWebCryptoKeyWrap, detectKeyWrapSupport, loadOrCreateAgreementKeys } from '../src/data/sync/envelope.ts';
import { createMemoryKeyValue } from '../src/data/local-repository.ts';
import type { DeviceStore } from '../src/data/op-ports.ts';

/**
 * "一人一把锁"：**用真的 WebCrypto 跑**（X25519 + HKDF + AES-GCM，Node 与浏览器同一套 API）。
 *
 * 要钉住的是三条：
 *  1. 名单里的人能解开自己那一份，拿到**同一把**内容密钥；
 *  2. **不在名单里的人解不开**（这就是"踢掉后读不到新内容"的密码学依据）；
 *  3. 换一把内容密钥（epoch+1）后，旧钥匙开不了新东西。
 */

const SUPPORTED = await detectKeyWrapSupport();

test('运行环境支持 X25519（不支持的话这一层必须走另外的路，不能假装能用）', () => {
  assert.equal(SUPPORTED, true);
});

test('一人一把锁：名单里的人拿得到同一把钥匙，名单外的人拿不到', async () => {
  const port = createWebCryptoKeyWrap();
  const alice = await port.generateAgreementKeys();
  const bob = await port.generateAgreementKeys();
  const mallory = await port.generateAgreementKeys();

  const { keyring, contentKey } = await createKeyring(
    port,
    [
      { deviceId: 'alice', publicKey: alice.publicKey },
      { deviceId: 'bob', publicKey: bob.publicKey },
    ],
    1,
  );

  assert.equal(keyring.epoch, 1);
  assert.equal(keyring.entries.length, 2);
  // 两个包里装的必须是同一把内容密钥
  const forAlice = await openKeyring(port, keyring, 'alice', alice.privateKey, alice.publicKey);
  const forBob = await openKeyring(port, keyring, 'bob', bob.privateKey, bob.publicKey);
  assert.deepEqual([...forAlice], [...contentKey]);
  assert.deepEqual([...forBob], [...contentKey]);

  // 不在名单里：连"那一份"都不存在
  await assert.rejects(
    () => openKeyring(port, keyring, 'mallory', mallory.privateKey, mallory.publicKey),
    /没有包给设备 mallory/,
  );

  // 冒充：拿别人的那一份用自己的私钥开，必须失败（AEAD 认证失败）
  const bobEntry = keyring.entries.find((entry) => entry.deviceId === 'bob')!;
  await assert.rejects(() => port.unwrapWith(mallory.privateKey, mallory.publicKey, bobEntry.wrapped));

  // 被改过的包也要失败（认证过）
  const tampered = `${bobEntry.wrapped.slice(0, -4)}AAAA`;
  await assert.rejects(() => port.unwrapWith(bob.privateKey, bob.publicKey, tampered));
});

test('换钥匙（epoch+1）：被踢的人手里那把开不了新东西，剩下的人照常', async () => {
  const port = createWebCryptoKeyWrap();
  const alice = await port.generateAgreementKeys();
  const bob = await port.generateAgreementKeys();

  const first = await createKeyring(port, [{ deviceId: 'alice', publicKey: alice.publicKey }, { deviceId: 'bob', publicKey: bob.publicKey }], 1);
  // 踢掉 bob：只包给 alice
  const second = await createKeyring(port, [{ deviceId: 'alice', publicKey: alice.publicKey }], 2);

  assert.equal(second.keyring.epoch, 2);
  assert.notDeepEqual([...second.contentKey], [...first.contentKey], '换代必须换钥匙');
  assert.equal(second.keyring.entries.length, 1);

  const aliceKey = await openKeyring(port, second.keyring, 'alice', alice.privateKey, alice.publicKey);
  assert.deepEqual([...aliceKey], [...second.contentKey]);

  await assert.rejects(
    () => openKeyring(port, second.keyring, 'bob', bob.privateKey, bob.publicKey),
    /没有包给设备 bob/,
  );
});

test('keyring 的读写：坏数据要说清哪坏了', () => {
  const good = serializeKeyring({ v: 1, epoch: 3, entries: [{ deviceId: 'a', wrapped: 'xx' }] });
  assert.deepEqual(parseKeyring(good), { v: 1, epoch: 3, entries: [{ deviceId: 'a', wrapped: 'xx' }] });
  assert.throws(() => parseKeyring('不是 json'), /不是合法 JSON/);
  assert.throws(() => parseKeyring('{"v":2,"epoch":1,"entries":[]}'), /版本不认识/);
  assert.throws(() => parseKeyring('{"v":1,"entries":[]}'), /缺少 epoch/);
  assert.throws(() => parseKeyring('{"v":1,"epoch":1,"entries":[{"deviceId":"a"}]}'), /缺少 deviceId\/wrapped/);
});

test('没公布公钥的设备：宁可不给它包，也不发一份"谁都能开"的', async () => {
  const port = createWebCryptoKeyWrap();
  await assert.rejects(
    () => createKeyring(port, [{ deviceId: 'newbie', publicKey: '' }], 1),
    /还没公布公钥/,
  );
});

test('协商密钥：第一次生成并落地，之后每次复用同一把（换身份等于换人，别人包给旧的会解不开）', async () => {
  const store = createMemoryKeyValue();
  const device: DeviceStore = {
    async get(key) {
      return store.read(key);
    },
    async set(key, value) {
      store.write(key, value);
    },
  };
  const port = createWebCryptoKeyWrap();
  const first = await loadOrCreateAgreementKeys(port, device);
  assert.equal(first.publicKey.length > 0, true);
  assert.ok((await device.get(AGREEMENT_KEY_KEY)) !== undefined);

  const second = await loadOrCreateAgreementKeys(port, device);
  assert.deepEqual(second, first);

  // 坏数据要被当成"还没有密钥"，重新生成一把并覆盖
  await device.set(AGREEMENT_KEY_KEY, '{坏的');
  const third = await loadOrCreateAgreementKeys(port, device);
  assert.notDeepEqual(third, first);
});
