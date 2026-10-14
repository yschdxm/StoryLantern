import { execFileSync } from 'node:child_process';

/**
 * 真机验证 ⑦ 的「导入带多次生成的记录 → 切候选」。
 *
 * 用 Node 直接调 adb：PowerShell 传引号/花括号会变形，而这段 JSON 全是引号。
 * 文本必须是 ASCII（`input text` 不支持中文），所以内容用英文，界面文案由代码给。
 */
const ADB = `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const SERIAL = '127.0.0.1:6555';

function adb(...args) {
  return execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' });
}

const charName = 'Swipe Test';
const lines = [
  JSON.stringify({ user_name: 'You', character_name: charName, mes: 'hello', is_user: true }),
  JSON.stringify({ user_name: 'You', character_name: charName, mes: 'reply one', is_user: false, swipes: ['reply one', 'reply two', 'reply three'] }),
  JSON.stringify({ user_name: 'You', character_name: charName, mes: 'again', is_user: true }),
];

// 1) 聚焦粘贴框（导入页的 textarea）
adb('shell', 'input', 'tap', '541', '973');
console.log('  已聚焦粘贴框');
execFileSync('node', ['-e', 'setTimeout(()=>{},400)']);

for (let index = 0; index < lines.length; index += 1) {
  // 空格在 adb input text 里要写成 %s
  const text = lines[index].replace(/ /g, '%s');
  adb('shell', 'input', 'text', text);
  if (index < lines.length - 1) adb('shell', 'input', 'keyevent', '66');
  console.log(`  第 ${index + 1} 行已输入（${lines[index].length} 字符）`);
}

// 2) 解析
adb('shell', 'input', 'tap', '165', '1217');
console.log('  已点「解析」');
