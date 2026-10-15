import { writeFileSync } from 'node:fs';

/**
 * 造一份"聊天记录（JSONL）"夹具，用来量移动端的滚动性能（PLAN §11 / M3 的 200 消息 ≥55fps）。
 *
 * 用途很具体：真机上要测帧率，就得先有**足够多的真实消息**——而且必须走**真实的导入链路**
 * （导入会经 op 日志落库，不是往界面里塞假数据）。所以这个脚本只负责"造一份格式正确的聊天记录"，
 * 剩下的交给应用自己的导入流程。
 *
 * 格式按 `packages/importer/src/chat.ts` 的识别规则来：
 *  - 首行可以是元信息（`user_name` / `character_name` / `create_date`）；
 *  - 之后每行一条消息：`mes` 为正文，`is_user` 区分谁说的（也接受 `role: 'user'`）。
 *
 * 用法：
 *   node scripts/make-chat-fixture.mjs 200 .apk-out/lantern-200.jsonl
 *   adb push .apk-out/lantern-200.jsonl /sdcard/Documents/
 *   # 然后在应用里：设置 → 导入 → 选择文件 → Documents → 选中它
 */

const count = Number.parseInt(process.argv[2] ?? '200', 10);
const out = process.argv[3] ?? '.apk-out/lantern-200.jsonl';
if (!Number.isFinite(count) || count <= 0) {
  console.error('用法：node scripts/make-chat-fixture.mjs <消息条数> [输出文件]');
  process.exit(1);
}

const lines = [
  JSON.stringify({ user_name: '我', character_name: '星野', create_date: new Date().toISOString().slice(0, 10) }),
];
const topics = [
  '风从北面来，带着雪线的味道。',
  '隘口的守夜人换班了。',
  '雪停了，星星亮得像撒了一地盐。',
  '我把灯芯剪短了些，火苗稳下来。',
  '你听，远处有雪崩的声音。',
  '茶水还热，先喝一口。',
  '这条路上没有第二个脚印。',
  '天亮之前别睡，风声会骗人。',
  '旧地图上这里画着一棵树。',
  '我数到一百，你就该回来了。',
];
for (let index = 0; index < count; index += 1) {
  const isUser = index % 2 === 0;
  lines.push(
    JSON.stringify({
      name: isUser ? '我' : '星野',
      is_user: isUser,
      mes: `${topics[index % topics.length]}（第 ${index + 1} 条）`,
    }),
  );
}

writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
console.log(`已写出 ${out}：1 行元信息 + ${count} 条消息`);
