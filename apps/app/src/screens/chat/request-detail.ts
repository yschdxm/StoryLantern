/**
 * “请求详情”的纯逻辑：cURL 生成 + 行级 diff。
 *
 * 这里**不重新拼请求体**：调用方传进来的 body 必须就是 `chat.preview` 返回的那一份，
 * 否则“面板显示的和实际发出去的不一样”就失去了可解释性的意义。
 */

export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

const MAX_DIFF_CELLS = 250_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 生成可复制的 cURL。
 * Authorization 一律脱敏成 `Bearer ••••`：面板可以给用户看/复制，但不能把密钥带出去。
 */
export function curlOf(url: string, body: string): string {
  return [
    `curl -sS -X POST ${shellQuote(url)}`,
    `  -H 'Content-Type: application/json'`,
    `  -H 'Authorization: Bearer ••••'`,
    `  --data-raw ${shellQuote(body)}`,
  ].join(' \\\n');
}

function coarseDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  const lines: DiffLine[] = [];
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const oldLine = before[index];
    const newLine = after[index];
    if (oldLine === newLine && oldLine !== undefined) lines.push({ kind: 'same', text: oldLine });
    else {
      if (oldLine !== undefined) lines.push({ kind: 'remove', text: oldLine });
      if (newLine !== undefined) lines.push({ kind: 'add', text: newLine });
    }
  }
  return lines;
}

/**
 * 行级 diff（LCS）。`before === undefined` 表示没有上一轮，不显示差异。
 * 请求体大时退化为按行对齐的粗 diff（仍分 +/-，只是不追求最小编辑距离）。
 */
export function diffLines(before: string | undefined, after: string): DiffLine[] {
  if (before === undefined) return [];
  if (before === after) return after.split('\n').map((text) => ({ kind: 'same', text }));
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > MAX_DIFF_CELLS) return coarseDiff(a, b);

  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? 1 + (table[(i + 1) * width + (j + 1)] ?? 0)
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + (j + 1)] ?? 0);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: 'same', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + (j + 1)] ?? 0)) {
      lines.push({ kind: 'remove', text: a[i] ?? '' });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: b[j] ?? '' });
      j += 1;
    }
  }
  while (i < a.length) {
    lines.push({ kind: 'remove', text: a[i] ?? '' });
    i += 1;
  }
  while (j < b.length) {
    lines.push({ kind: 'add', text: b[j] ?? '' });
    j += 1;
  }
  return lines;
}
