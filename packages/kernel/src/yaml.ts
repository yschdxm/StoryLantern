/**
 * 组合文件的 YAML 子集解析器（零依赖）。
 *
 * 只覆盖 Story Lantern 组合方言所需的形态，刻意不支持锚点、多文档、块标量：
 *  - 顶层是序列，元素是 map（`- id: x`）；
 *  - 嵌套 map 用缩进；
 *  - 标量：字符串 / 数字 / 布尔 / null / 单双引号字符串；
 *  - 内联数组 `[a, b]`；
 *  - 行尾注释 `#`；
 *  - `!!js "表达式"` 标记为待求值表达式（由 loader 决定是否求值）。
 *
 * 这不是通用 YAML，遇到不支持的形态会明确报错，绝不静默猜测。
 */

export interface YamlJsExpression {
  readonly __js: string;
}

export function isJsExpression(value: unknown): value is YamlJsExpression {
  return typeof value === 'object' && value !== null && typeof (value as YamlJsExpression).__js === 'string';
}

export class YamlError extends Error {
  readonly line: number | undefined;

  constructor(message: string, line?: number) {
    super(line === undefined ? message : `第 ${line} 行：${message}`);
    this.name = 'YamlError';
    this.line = line;
  }
}

interface Line {
  indent: number;
  text: string;
  number: number;
}

function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      const before = i === 0 ? ' ' : (raw[i - 1] ?? ' ');
      if (/\s/.test(before)) return raw.slice(0, i);
    }
  }
  return raw;
}

function tokenize(text: string): Line[] {
  const lines: Line[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.includes('\t')) throw new YamlError('不允许制表符缩进', index + 1);
    const withoutComment = stripComment(raw);
    if (withoutComment.trim() === '') return;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, text: withoutComment.trim(), number: index + 1 });
  });
  return lines;
}

function unquote(text: string, line?: number): string {
  const first = text[0];
  if (first === '"' || first === "'") {
    if (text.length < 2 || text[text.length - 1] !== first) {
      throw new YamlError(`引号未闭合：${text}`, line);
    }
    const inner = text.slice(1, -1);
    if (first === "'") return inner.replace(/''/g, "'");
    return inner.replace(/\\(["\\/bfnrt])/g, (_, code: string) => {
      switch (code) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        case 'b':
          return '\b';
        case 'f':
          return '\f';
        default:
          return code;
      }
    });
  }
  return text;
}

function splitInline(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of text) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') depth += 1;
      if (ch === ']' || ch === '}') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function parseScalar(raw: string, line?: number): unknown {
  const text = raw.trim();
  if (text === '') return null;
  if (text.startsWith('!!js')) {
    const expr = text.slice(5).trim();
    if (expr === '') throw new YamlError('!!js 缺少表达式', line);
    return { __js: unquote(expr, line) } satisfies YamlJsExpression;
  }
  if (text === '[]') return [];
  if (text === '{}') return {};
  if (text.startsWith('[') && text.endsWith(']')) {
    return splitInline(text.slice(1, -1)).map((part) => parseScalar(part, line));
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const out: Record<string, unknown> = {};
    for (const part of splitInline(text.slice(1, -1))) {
      const colon = part.indexOf(':');
      if (colon < 0) throw new YamlError(`内联 map 缺少 ':'：${part}`, line);
      out[unquote(part.slice(0, colon).trim(), line)] = parseScalar(part.slice(colon + 1), line);
    }
    return out;
  }
  if (/^["']/.test(text)) return unquote(text, line);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null' || text === '~') return null;
  if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10);
  if (/^-?\d*\.\d+(?:[eE][-+]?\d+)?$/.test(text)) return Number.parseFloat(text);
  return text;
}

function isMapEntry(text: string): boolean {
  return /^[^\s:][^:]*:(\s|$)/.test(text);
}

interface Cursor {
  index: number;
}

function parseBlock(lines: Line[], cursor: Cursor, indent: number): unknown {
  const first = lines[cursor.index];
  if (!first) return null;
  if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(lines, cursor, indent);
  return parseMap(lines, cursor, indent);
}

function parseSeq(lines: Line[], cursor: Cursor, indent: number): unknown[] {
  const out: unknown[] = [];
  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (!line) break;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('序列元素缩进不一致', line.number);
    if (!(line.text === '-' || line.text.startsWith('- '))) break;

    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest === '') {
      cursor.index += 1;
      const next = lines[cursor.index];
      if (next && next.indent > indent) out.push(parseBlock(lines, cursor, next.indent));
      else out.push(null);
      continue;
    }
    if (isMapEntry(rest)) {
      lines[cursor.index] = { indent: indent + 2, text: rest, number: line.number };
      out.push(parseMap(lines, cursor, indent + 2));
      continue;
    }
    out.push(parseScalar(rest, line.number));
    cursor.index += 1;
  }
  return out;
}

function parseMap(lines: Line[], cursor: Cursor, indent: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (!line) break;
    if (line.indent < indent) break;
    if (line.indent > indent) throw new YamlError('map 缩进不一致', line.number);
    if (line.text === '-' || line.text.startsWith('- ')) break;
    if (!isMapEntry(line.text)) throw new YamlError(`无法解析的映射项：${line.text}`, line.number);

    const colon = line.text.indexOf(':');
    const key = unquote(line.text.slice(0, colon).trim(), line.number);
    const rest = line.text.slice(colon + 1).trim();
    cursor.index += 1;

    if (rest === '') {
      const next = lines[cursor.index];
      if (next && next.indent > indent) out[key] = parseBlock(lines, cursor, next.indent);
      else out[key] = null;
    } else {
      out[key] = parseScalar(rest, line.number);
    }
  }
  return out;
}

/** 解析组合方言 YAML 子集。空文档返回 null；`[]` 返回空数组（空 profile 根）。 */
export function parseYaml(text: string): unknown {
  const lines = tokenize(text);
  if (lines.length === 0) return null;
  const first = lines[0];
  if (!first) return null;
  if (lines.length === 1 && first.text === '[]') return [];
  const cursor: Cursor = { index: 0 };
  const value = parseBlock(lines, cursor, first.indent);
  if (cursor.index !== lines.length) {
    const leftover = lines[cursor.index];
    throw new YamlError(`解析结束后仍有未消费内容：${leftover?.text ?? ''}`, leftover?.number);
  }
  return value;
}

/** 把 `!!js` 表达式就地求值（仅用于本地 profile/patch 文件；调用方可关闭）。 */
export function resolveJsExpressions(
  value: unknown,
  scope: Record<string, unknown>,
  options: { allowJs?: boolean } = {},
): { value: unknown; warnings: string[] } {
  const warnings: string[] = [];
  const allowJs = options.allowJs ?? true;

  const walk = (input: unknown, path: string): unknown => {
    if (isJsExpression(input)) {
      const expr = input.__js;
      if (!allowJs) {
        warnings.push(`${path}: 已忽略 !!js 表达式（当前不允许求值）`);
        return undefined;
      }
      try {
        const names = Object.keys(scope);
        const fn = new Function(...names, `"use strict"; return (${expr});`);
        return fn(...names.map((name) => scope[name]));
      } catch (error) {
        warnings.push(`${path}: !!js 求值失败：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }
    if (Array.isArray(input)) return input.map((item, index) => walk(item, `${path}[${index}]`));
    if (input !== null && typeof input === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
        const resolved = walk(child, path === '' ? key : `${path}.${key}`);
        if (resolved !== undefined) out[key] = resolved;
      }
      return out;
    }
    return input;
  };

  return { value: walk(value, ''), warnings };
}
