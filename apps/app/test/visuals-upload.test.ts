import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetRefOf, hashOfAssetRef } from '../src/data/asset-client.ts';
import {
  MAX_VISUAL_IMAGE_BYTES,
  imageErrorKey,
  validatePickedImage,
} from '../src/data/visuals-form.ts';

/**
 * 图片上传的纯逻辑：资产引用格式 + 文件大小/类型校验。
 * 真正的选择器/缩略图是浏览器行为（由 smoke/e2e 覆盖），这里只钉数据结构与文案 key。
 */

const HASH = 'a'.repeat(64);

test('资产引用：合法 sha256 → asset://<hash>，大小写归一', () => {
  assert.equal(assetRefOf(HASH), `asset://${HASH}`);
  assert.equal(hashOfAssetRef(`asset://${HASH}`), HASH);
  assert.equal(hashOfAssetRef(`asset://${HASH.toUpperCase()}`), HASH, '引用里的 hash 按小写归一');
});

test('资产引用：非法/绝对路径/空值一律不认', () => {
  for (const value of [
    undefined,
    '',
    'asset://',
    'asset://abc',
    `asset://${'g'.repeat(64)}`,
    `asset://${'a'.repeat(63)}`,
    `asset://${'a'.repeat(65)}`,
    'C:/pics/portrait.png',
    '/home/user/pic.png',
    'https://example.com/x.png',
  ]) {
    assert.equal(hashOfAssetRef(value), undefined, `应当拒绝：${String(value)}`);
  }
});

test('文件校验：白名单类型 + 8 MB 上限', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'IMAGE/PNG']) {
    assert.deepEqual(validatePickedImage({ size: 100, type }), { ok: true }, type);
  }
  assert.equal(MAX_VISUAL_IMAGE_BYTES, 8 * 1024 * 1024);
  assert.deepEqual(validatePickedImage({ size: MAX_VISUAL_IMAGE_BYTES, type: 'image/png' }), { ok: true }, '刚好 8 MB 允许');
});

test('文件校验：空文件 / 超限 / 类型不对分别给 code（不静默）', () => {
  assert.deepEqual(validatePickedImage({ size: 0, type: 'image/png' }), { ok: false, code: 'empty' });
  assert.deepEqual(validatePickedImage({ size: MAX_VISUAL_IMAGE_BYTES + 1, type: 'image/png' }), {
    ok: false,
    code: 'too-large',
  });
  assert.deepEqual(validatePickedImage({ size: 10, type: 'image/svg+xml' }), { ok: false, code: 'bad-type' });
  assert.deepEqual(validatePickedImage({ size: 10, type: 'text/plain' }), { ok: false, code: 'bad-type' });
  assert.deepEqual(validatePickedImage({ size: Number.NaN, type: 'image/png' }), { ok: false, code: 'empty' });
});

test('错误 code → i18n key（四段式文案在 catalog）', () => {
  assert.equal(imageErrorKey('too-large'), 'visuals.upload.too-large');
  assert.equal(imageErrorKey('bad-type'), 'visuals.upload.bad-type');
  assert.equal(imageErrorKey('empty'), 'visuals.upload.empty');
  assert.equal(imageErrorKey('put-failed'), 'visuals.upload.put-failed');
});
