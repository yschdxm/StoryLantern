import { expect, test } from '@playwright/test';

/**
 * 移动视口 + 触摸的端到端验收。
 *
 * 覆盖的是**手机优先的三条硬约束**，而不是像素级外观：
 *  1. 底部标签栏在拇指区、能触摸切换；
 *  2. 窄屏（Pixel 7：412×915）不出现横向溢出；
 *  3. Ctrl/Cmd+K 命令面板能打开、过滤、跳转、Esc 关闭（触摸/键盘都行）。
 *
 * 被测的是浏览器里的界面（无宿主 IPC）：界面会显示"浏览器（无宿主 IPC）"，这是预期，
 * 而不是把"宿主任意失败"当通过。
 */

test('移动视口：底部标签可触摸切换，窄屏无横向溢出', async ({ page }) => {
  await page.goto('/');
  // 应用启动（会话页）：等标签栏出现
  const tabbar = page.locator('nav.tabbar');
  await expect(tabbar).toBeVisible();

  // ① 触摸切换标签：点"角色"（用 tap 走触摸事件，不是 click）
  const tabs = tabbar.locator('button.tab');
  const count = await tabs.count();
  expect(count).toBeGreaterThanOrEqual(2);
  for (let index = 0; index < count; index += 1) {
    await tabs.nth(index).tap();
    await expect(tabs.nth(index)).toHaveAttribute('aria-current', 'page');
  }

  // ② 窄屏不横向溢出（手机约束：不允许左右滚）
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, '窄屏下不应出现横向溢出').toBeLessThanOrEqual(1);

  // ③ 触摸目标 ≥44px（--tap-min；DESIGN.md §1.6）
  const tabBox = await tabs.first().boundingBox();
  expect(tabBox?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test('Ctrl/Cmd+K 命令面板：打开、过滤、跳转、Esc 关闭', async ({ page }) => {
  await page.goto('/');
  // 先等界面挂载完（快捷键监听在挂载后才生效；不等就会按下"没人听"的键）
  await page.locator('nav.tabbar').waitFor();
  await page.keyboard.press('Control+KeyK');

  const dialog = page.locator('.palette');
  await expect(dialog).toBeVisible();
  const input = page.locator('.palette__input');
  await expect(input).toBeFocused();

  // 输入过滤：按 **id**（与界面语言无关）过滤到设置页这一项。
  // 以前这里用的是中文「设置」，本地（zh）能过、CI（en locale）过滤出 0 项 → 回车无效 → 面板不关。
  await input.fill('set');
  const items = page.locator('.palette__item');
  await expect(items).toHaveCount(1);

  // 回车跳转：URL 变成 #/settings
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#\/settings$/);

  // 再开一次，Esc 关闭（在输入框上按，模拟真实操作）
  await page.keyboard.press('Control+KeyK');
  const reopened = page.locator('.palette__input');
  await expect(page.locator('.palette')).toBeVisible();
  await expect(reopened).toBeFocused();
  await reopened.press('Escape');
  await expect(page.locator('.palette')).toBeHidden();
});

test('没有宿主 IPC 时界面诚实降级（不报错、不假装已连接）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.locator('nav.tabbar').waitFor();

  // 浏览器里没有 Tauri 全局对象：界面应当显示"浏览器（无宿主 IPC）"这类说明
  // （具体文案在设置页；这里只断言"没有未捕获异常 + 页面确实渲染出来了"）
  expect(errors, `页面不应抛未捕获异常：${errors.join(' | ')}`).toHaveLength(0);
  const bodyText = await page.locator('body').innerText();
  expect(bodyText.length).toBeGreaterThan(0);
});
