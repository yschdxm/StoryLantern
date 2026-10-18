import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curlOf, diffLines } from '../src/screens/chat/request-detail.ts';

/** 请求详情的纯逻辑：cURL 必须脱敏；diff 必须真的分 +/-。 */

test('curlOf：带 URL/body，Authorization 固定脱敏', () => {
  const curl = curlOf('https://api.example.com/v1/chat/completions', '{"model":"m"}');
  assert.match(curl, /^curl -sS -X POST 'https:\/\/api\.example\.com\/v1\/chat\/completions'/);
  assert.match(curl, /Content-Type: application\/json/);
  assert.match(curl, /Authorization: Bearer ••••/);
  assert.doesNotMatch(curl, /sk-[A-Za-z0-9]+/, '不能出现看起来像密钥的片段');
  assert.match(curl, /--data-raw '\{"model":"m"\}'/);
});

test('curlOf：body 里的单引号被安全转义，不会截断 shell 参数', () => {
  const curl = curlOf('https://x.test', `{"q":"it's fine"}`);
  assert.match(curl, /it'\\''s fine/);
});

test('diffLines：新增/删除/相同行分别标记，undefined 表示没有上一轮', () => {
  assert.deepEqual(diffLines(undefined, 'a'), []);
  const diff = diffLines('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(
    diff.map((line) => [line.kind, line.text]),
    [
      ['same', 'a'],
      ['remove', 'b'],
      ['add', 'B'],
      ['same', 'c'],
      ['add', 'd'],
    ],
  );
});

test('diffLines：相同请求没有变化行', () => {
  const diff = diffLines('{"a":1}', '{"a":1}');
  assert.deepEqual(diff, [{ kind: 'same', text: '{"a":1}' }]);
});
