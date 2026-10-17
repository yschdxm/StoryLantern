import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { importFile, ImportError } from '../src/index.ts';

/**
 * 畸形样本必须**真的失败**（而且带 code）。
 *
 * 这一条的价值：`fixtures/test/fixtures.test.ts` 只证明"文件本身是坏的"；
 * 这里证明"我们的导入器认得出它坏，并给出可显示给用户的 code"——
 * 否则坏文件会被静默接受，用户以为导入成功。
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', 'fixtures');
const read = (relative: string) => readFile(path.join(ROOT, relative));

const CASES: { file: string; code: string }[] = [
  { file: 'malformed/bad-card.json', code: 'bad-json' },
  { file: 'malformed/lorebook-empty.json', code: 'bad-lorebook' },
  { file: 'malformed/zip-no-card.charx', code: 'no-card-in-charx' },
  { file: 'malformed/truncated-card.png', code: 'truncated-png' },
  { file: 'malformed/empty.json', code: 'empty-file' },
];

for (const { file, code } of CASES) {
  test(`畸形样本 ${file} 必须抛 ImportError(${code})`, async () => {
    const bytes = await read(file);
    await assert.rejects(
      () => importFile(path.basename(file), new Uint8Array(bytes)),
      (error: unknown) => {
        assert.ok(error instanceof ImportError, `应当是 ImportError，实际是 ${String(error)}`);
        assert.equal(error.code, code);
        return true;
      },
    );
  });
}

test('没有名字的 JSON 卡：不得被当成角色卡导入（要么报 bad-card，要么明确 unknown）', async () => {
  const bytes = await read('malformed/card-no-name.json');
  try {
    const imported = await importFile('card-no-name.json', new Uint8Array(bytes));
    assert.equal(imported.kind, 'unknown', '没有名字的卡不能被当成角色卡导入');
  } catch (error) {
    assert.ok(error instanceof ImportError);
    assert.equal(error.code, 'bad-card');
  }
});

test('坏 JSONL：单行坏掉时整份记录仍然可导入，并如实报"跳过了几行"', async () => {
  const bytes = await read('malformed/bad-chat.jsonl');
  const imported = await importFile('bad-chat.jsonl', new Uint8Array(bytes));
  assert.equal(imported.kind, 'chat');
  if (imported.kind === 'chat') {
    assert.equal(imported.messages.length, 2, '坏行跳过，两条正常消息照常导入');
    assert.ok(imported.notes.some((note) => note.includes('无法解析')), '必须告诉用户跳过了行');
  }
});
