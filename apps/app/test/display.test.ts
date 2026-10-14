import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, isLocalEndpoint, isModelConfigured, previewOf } from '../src/data/repository.ts';

/**
 * 展示与判定的纯规则。单独一个文件：这些规则与仓储契约无关，
 * 混在契约文件里会让那个文件不断膨胀（门禁 400 行）。
 */

test('时间与会话预览的展示规则', () => {
  const now = new Date('2026-10-14T12:00:00').getTime();
  assert.equal(formatTime(0), '');
  assert.equal(formatTime(now - 30_000, now), '刚刚');
  assert.equal(formatTime(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(formatTime(new Date('2026-10-14T09:05:00').getTime(), now), '09:05');
  assert.equal(formatTime(new Date('2026-10-13T22:00:00').getTime(), now), '昨天');
  assert.equal(formatTime(new Date('2026-10-08T10:00:00').getTime(), now), '10 月 8 日');

  assert.equal(previewOf('  '), '还没有消息');
  assert.equal(previewOf('一\n二  三'), '一 二 三');
  assert.equal(previewOf('x'.repeat(80)).length, 61);
});

test('模型配置判定：远端要密钥、本地端点不需要（与 Rust 侧规则一致）', () => {
  assert.equal(isModelConfigured({}), false);
  assert.equal(isModelConfigured({ 'model.base_url': 'https://api.deepseek.com/v1' }), false, '缺模型名不算配置好');
  assert.equal(
    isModelConfigured({ 'model.base_url': 'https://api.deepseek.com/v1', 'model.name': 'deepseek-chat' }),
    false,
    '远端没有密钥不能发话',
  );
  assert.equal(
    isModelConfigured({ 'model.base_url': 'https://api.deepseek.com/v1', 'model.name': 'deepseek-chat', 'model.api_key': 'sk-x' }),
    true,
  );
  for (const local of ['http://127.0.0.1:8080/v1', 'http://localhost:1234/v1', 'http://10.0.2.2:15198/v1', 'http://192.168.1.9:5000/v1']) {
    assert.equal(isLocalEndpoint(local), true, local);
    assert.equal(isModelConfigured({ 'model.base_url': local, 'model.name': 'mock' }), true, `${local} 不需要密钥`);
  }
  assert.equal(isLocalEndpoint('https://api.deepseek.com/v1'), false);
});
