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

test('设置三级可达：L1 五组 → 同步与设备 → 返回 L1', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  // 直接打开设置首页（L1）：5 个分组入口 + 关于，任何语言下都用 data-testid 定位
  await page.goto('/#/settings');
  const home = page.locator('[data-testid="settings-home"]');
  await expect(home).toBeVisible();
  for (const section of ['model', 'appearance', 'sync', 'data', 'advanced'] as const) {
    await expect(page.getByTestId(`settings-section-${section}`)).toBeVisible();
  }
  await expect(page.getByTestId('settings-section-about')).toBeVisible();

  // 触控目标 ≥44px（L2 行的硬约束）
  const syncRow = page.getByTestId('settings-section-sync');
  expect((await syncRow.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

  // 搜索：匹配关键词后直达对应 L3（model.chat → 聊天模型详情）
  await page.locator('.settings-home__search').fill('deepseek');
  const searchHit = page.getByTestId('settings-search-result-model.chat');
  await expect(searchHit).toBeVisible();
  await searchHit.tap();
  await expect(page).toHaveURL(/#\/settings\/model$/);
  await expect(page.getByTestId('settings-detail-model')).toBeVisible();
  await page.getByTestId('settings-detail-model').locator('.btn').first().tap();
  await expect(page.getByTestId('settings-section-model-page')).toBeVisible();
  await page.locator('.settings-breadcrumb__link').tap();
  await expect(home).toBeVisible();

  // 进 L2：同步与设备
  await syncRow.tap();
  await expect(page).toHaveURL(/#\/settings\/sync$/);
  await expect(page.getByTestId('settings-section-sync-page')).toBeVisible();
  // 底栏仍高亮「设置」（activeTabName 对分区页返回 settings）
  await expect(page.locator('nav.tabbar .tab--active')).toHaveCount(1);

  // 返回 L1：AppBar 的返回键（parentOf 让分区页回到设置首页）
  await page.locator('.appbar .icon-btn').first().tap();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(home).toBeVisible();

  // L3 也真实存在：模型与密钥 → 聊天模型 → 详情页 → 页内返回 L2
  await page.getByTestId('settings-section-model').tap();
  await expect(page.getByTestId('settings-section-model-page')).toBeVisible();
  await page.getByTestId('settings-section-model-page').locator('.settings-row--button').first().tap();
  const detail = page.getByTestId('settings-detail-model');
  await expect(detail).toBeVisible();
  await detail.locator('.btn').first().tap();
  await expect(page.getByTestId('settings-section-model-page')).toBeVisible();
  await page.locator('.appbar .icon-btn').first().tap();
  await expect(home).toBeVisible();

  // 直接深链 #/settings/sync 也能渲染（P1-a 的验收）
  await page.goto('/#/settings/sync');
  await expect(page.getByTestId('settings-section-sync-page')).toBeVisible();

  expect(errors, `设置页不应抛未捕获异常：${errors.join(' | ')}`).toHaveLength(0);
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

test('世界页：第三个标签进入世界资源，类型筛选与新建入口可见', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('nav.tabbar')).toBeVisible();

  // 第三个标签是「世界」（ADR-0011：世界书 → 场景簿/物品图鉴/典籍）
  await page.locator('nav.tabbar button.tab').nth(2).tap();
  await expect(page).toHaveURL(/#\/world$/);

  // 五个筛选 chips：全部 / 场景 / 物品 / 典籍 / 世界包（按位置选，与语言无关）
  const filters = page.locator('.world-filters .chip');
  await expect(filters).toHaveCount(5);
  await filters.nth(1).tap();
  // 浏览器里没有数据：筛选后仍是空态（不要求 world-list 存在），只断言筛选真的生效
  await expect(page.getByTestId('world-filter-scene')).toHaveAttribute('aria-pressed', 'true');

  // 一屏一个主按钮：新建卡片（FAB 有无障碍名，与语言无关的是类名）
  await expect(page.locator('.fab')).toBeVisible();
  expect(errors, `世界页不应抛未捕获异常：${errors.join(' | ')}`).toHaveLength(0);
});

test('世界卡编辑器路由：缩窄到场景新建页且无未捕获异常', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/#/worldcard/scene/new');
  // 编辑器外壳（form-screen）应渲染；空表单不算错误
  await expect(page.locator('.form-screen')).toBeVisible();
  await expect(page.locator('form, .form')).toHaveCount(1);
  expect(errors, `世界卡编辑器不应抛未捕获异常：${errors.join(' | ')}`).toHaveLength(0);
});

test('导入页与新建会话页：路由可达且不抛异常（浏览器无宿主时诚实降级）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/#/import');
  await expect(page.locator('body')).toContainText(/\S/);
  await expect(page).toHaveURL(/#\/import$/);

  await page.goto('/#/session/new');
  // 浏览器最小实现没有卡片仓储/会话创建能力：页面必须显示可读提示，而不是白屏
  await expect(page.locator('main')).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text.length).toBeGreaterThan(0);
  expect(errors, `导入/新建会话页不应抛未捕获异常：${errors.join(' | ')}`).toHaveLength(0);
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
