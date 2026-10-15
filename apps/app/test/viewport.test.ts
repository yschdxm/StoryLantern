import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appHeightFrom } from '../src/ui/viewport.ts';

/**
 * 软键盘遮挡输入栏的修法靠这一个换算：根容器高度要取"布局视口"与"可视视口"的**小值**。
 *
 * 真机（Android 13 / WebView 104）上键盘弹出时布局视口不变、只有 visualViewport 变小，
 * 所以之前贴底的输入栏会被键盘盖住。这里把换算钉成断言，免得以后又被改回 `100%`。
 */

test('拿不到 visualViewport 时退回布局视口高度（桌面浏览器、老 WebView）', () => {
  assert.equal(appHeightFrom(800, undefined), 800);
});

test('键盘弹出（可视视口更小）时取小值，整列跟着缩', () => {
  // 布局视口 800，可视视口只剩 400（键盘占了 400）→ 根容器 400，输入栏落在键盘上方
  assert.equal(appHeightFrom(800, { height: 400 }), 400);
});

test('可视视口更大或数值不合理时不放大、不崩', () => {
  assert.equal(appHeightFrom(800, { height: 900 }), 800, '不该比布局视口还高');
  assert.equal(appHeightFrom(800, { height: 0 }), 800);
  assert.equal(appHeightFrom(800, { height: Number.NaN }), 800);
});
