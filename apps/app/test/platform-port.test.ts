import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryPlatformPort, createWebPlatformPort } from '../src/data/platform-port.ts';

/** PlatformPort：界面访问平台能力的唯一入口。两个实现（内存/Web）都要能替换。 */

test('内存实现：剪贴板写入后读得到，时间可固定（测试可复现）', async () => {
  const port = createMemoryPlatformPort({ now: () => 42 });
  assert.equal(port.kind, 'memory');
  await port.clipboard.write('配置档 JSON');
  assert.equal(await port.clipboard.read(), '配置档 JSON');
  assert.equal(port.clipboardText(), '配置档 JSON');
  assert.equal(port.now(), 42);
});

test('Web 实现：没有 navigator.clipboard 时明确抛错（不静默失败）', async () => {
  const port = createWebPlatformPort();
  assert.equal(port.kind, 'web');
  // Node 测试环境没有 navigator.clipboard —— 必须抛"不可用"，而不是假装成功
  await assert.rejects(() => port.clipboard.write('x'), /剪贴板/);
  await assert.rejects(() => port.clipboard.read(), /剪贴板/);
});
