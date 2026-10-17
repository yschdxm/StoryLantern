/**
 * 条件/表达式求值（**不用 eval、不用 Function**，自己写词法+递归下降）。
 *
 * 用途：角色规则 `rules[].when.conditions`、典籍 `trigger.conditions`、以及将来场景连接条件。
 * 语法（故意很小，够用就好）：
 *
 *   expr    := or
 *   or      := and ( "||" and )*
 *   and     := equality ( "&&" equality )*
 *   equality:= comparison ( ("=="|"!=") comparison )*
 *   compare := additive ( ("<"|"<="|">"|">=") additive )*
 *   additive:= multiply ( ("+"|"-") multiply )*
 *   multiply:= unary ( ("*"|"/"|"%") unary )*
 *   unary   := ("!"|"-") unary | primary
 *   primary := number | string | true | false | null | identifier | "(" expr ")"
 *
 * 取值：`number | string | boolean | null | undefined`。标识符从调用方给的 scope 里取；
 * **未知标识符是错误**（不是"当成 false"）——静默当成 false 会让作者以为规则生效了。
 */

export type ExprValue = number | string | boolean | null | undefined | readonly string[];

export interface ExprScope {
  readonly [name: string]: ExprValue;
}

export interface EvalResult {
  value: ExprValue;
  /** 求值失败原因（人不一定看得懂位置，但能说清是哪一步）。 */
  error?: string;
}

export interface ConditionResult {
  /** 条件是否成立（任何一条错误都视为不成立，并带 errors）。 */
  ok: boolean;
  errors: string[];
}

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'end' };

const PUNCT = ['&&', '||', '==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')'];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const numberMatch = /^\d+(?:\.\d+)?/.exec(source.slice(index));
    if (numberMatch !== null) {
      tokens.push({ kind: 'number', value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let cursor = index + 1;
      let text = '';
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor] as string;
        if (current === '\\' && cursor + 1 < source.length) {
          text += source[cursor + 1];
          cursor += 2;
          continue;
        }
        if (current === quote) {
          closed = true;
          cursor += 1;
          break;
        }
        text += current;
        cursor += 1;
      }
      if (!closed) throw new Error('字符串没有闭合');
      tokens.push({ kind: 'string', value: text });
      index = cursor;
      continue;
    }
    const identMatch = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(source.slice(index));
    if (identMatch !== null) {
      const word = identMatch[0];
      if (word === 'true' || word === 'false' || word === 'null') {
        tokens.push({ kind: 'ident', value: word });
      } else {
        tokens.push({ kind: 'ident', value: word });
      }
      index += word.length;
      continue;
    }
    const op = PUNCT.find((candidate) => source.startsWith(candidate, index));
    if (op === undefined) throw new Error(`无法识别的字符「${char}」`);
    tokens.push({ kind: 'op', value: op });
    index += op.length;
  }
  tokens.push({ kind: 'end' });
  return tokens;
}

class Parser {
  #tokens: Token[];
  #index = 0;
  readonly #scope: ExprScope;

  constructor(tokens: Token[], scope: ExprScope) {
    this.#tokens = tokens;
    this.#scope = scope;
  }

  parse(): ExprValue {
    const value = this.#or();
    const rest = this.#peek();
    if (rest.kind !== 'end') throw new Error(`表达式在「${describe(rest)}」之后还有多余内容`);
    return value;
  }

  #peek(): Token {
    return this.#tokens[this.#index] as Token;
  }

  #next(): Token {
    const token = this.#peek();
    this.#index += 1;
    return token;
  }

  #matchOp(op: string): boolean {
    const token = this.#peek();
    if (token.kind === 'op' && token.value === op) {
      this.#index += 1;
      return true;
    }
    return false;
  }

  #or(): ExprValue {
    let value = this.#and();
    while (this.#matchOp('||')) {
      const right = this.#and();
      value = Boolean(value) || Boolean(right);
    }
    return value;
  }

  #and(): ExprValue {
    let value = this.#equality();
    while (this.#matchOp('&&')) {
      const right = this.#equality();
      value = Boolean(value) && Boolean(right);
    }
    return value;
  }

  #equality(): ExprValue {
    let value = this.#comparison();
    for (;;) {
      if (this.#matchOp('==')) value = equal(value, this.#comparison());
      else if (this.#matchOp('!=')) value = !equal(value, this.#comparison());
      else return value;
    }
  }

  #comparison(): ExprValue {
    let value = this.#additive();
    for (;;) {
      if (this.#matchOp('<')) value = compare(value, this.#additive(), (a, b) => a < b);
      else if (this.#matchOp('<=')) value = compare(value, this.#additive(), (a, b) => a <= b);
      else if (this.#matchOp('>')) value = compare(value, this.#additive(), (a, b) => a > b);
      else if (this.#matchOp('>=')) value = compare(value, this.#additive(), (a, b) => a >= b);
      else return value;
    }
  }

  #additive(): ExprValue {
    let value = this.#multiply();
    for (;;) {
      if (this.#matchOp('+')) value = arith(value, this.#multiply(), '+');
      else if (this.#matchOp('-')) value = arith(value, this.#multiply(), '-');
      else return value;
    }
  }

  #multiply(): ExprValue {
    let value = this.#unary();
    for (;;) {
      if (this.#matchOp('*')) value = arith(value, this.#unary(), '*');
      else if (this.#matchOp('/')) value = arith(value, this.#unary(), '/');
      else if (this.#matchOp('%')) value = arith(value, this.#unary(), '%');
      else return value;
    }
  }

  #unary(): ExprValue {
    if (this.#matchOp('!')) return !Boolean(this.#unary());
    if (this.#matchOp('-')) {
      const value = this.#unary();
      if (typeof value !== 'number') throw new Error(`一元负号需要数字，收到 ${describeValue(value)}`);
      return -value;
    }
    return this.#primary();
  }

  #primary(): ExprValue {
    const token = this.#next();
    switch (token.kind) {
      case 'number':
      case 'string':
        return token.value;
      case 'ident': {
        if (token.value === 'true') return true;
        if (token.value === 'false') return false;
        if (token.value === 'null') return null;
        if (!Object.hasOwn(this.#scope, token.value)) throw new Error(`未知变量「${token.value}」`);
        return this.#scope[token.value];
      }
      case 'op': {
        if (token.value === '(') {
          const value = this.#or();
          if (!this.#matchOp(')')) throw new Error('括号没有闭合');
          return value;
        }
        throw new Error(`意外的运算符「${token.value}」`);
      }
      default:
        throw new Error('表达式不完整');
    }
  }
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'number':
      return String(token.value);
    case 'string':
      return `"${token.value}"`;
    case 'ident':
      return token.value;
    case 'op':
      return token.value;
    default:
      return '结尾';
  }
}

function describeValue(value: ExprValue): string {
  if (value === undefined) return '未定义';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `数组（${value.length} 项）`;
  return typeof value === 'string' ? `"${value}"` : String(value);
}

function equal(left: ExprValue, right: ExprValue): boolean {
  if (left === undefined || right === undefined) throw new Error('比较里有未定义的值');
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  if (left === null || right === null) return left === right;
  if (typeof left === 'number' && typeof right === 'number') return left === right;
  if (typeof left === 'string' && typeof right === 'string') return left === right;
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right;
  return false;
}

function compare(left: ExprValue, right: ExprValue, fn: (a: number, b: number) => boolean): boolean {
  if (typeof left !== 'number' || typeof right !== 'number') {
    if (typeof left === 'string' && typeof right === 'string') {
      const order = left.localeCompare(right);
      return fn(order, 0);
    }
    throw new Error(`大小比较需要两个数字或两个字符串，收到 ${describeValue(left)} 与 ${describeValue(right)}`);
  }
  return fn(left, right);
}

function arith(left: ExprValue, right: ExprValue, op: '+' | '-' | '*' | '/' | '%'): ExprValue {
  if (op === '+' && (typeof left === 'string' || typeof right === 'string')) {
    return `${left ?? ''}${right ?? ''}`;
  }
  if (typeof left !== 'number' || typeof right !== 'number') {
    throw new Error(`算术需要数字，收到 ${describeValue(left)} 与 ${describeValue(right)}`);
  }
  switch (op) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      if (right === 0) throw new Error('除以零');
      return left / right;
    case '%':
      if (right === 0) throw new Error('对零取余');
      return left % right;
  }
}

/** 求值一个表达式（不抛异常；错误放进 `error`）。 */
export function evaluateExpression(source: string, scope: ExprScope): EvalResult {
  try {
    const tokens = tokenize(source);
    return { value: new Parser(tokens, scope).parse() };
  } catch (cause) {
    return { value: undefined, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * 求值一组条件（AND 关系）。
 *
 * 空数组 = 恒成立（"没有条件"就是永远可用）。任何一条出错 → 整体不成立并带回 errors，
 * 调用方（规则/典籍）据此把条目标记为"未生效：条件无法求值"，而不是假装它生效。
 */
export function evaluateConditions(sources: readonly string[], scope: ExprScope): ConditionResult {
  const errors: string[] = [];
  for (const source of sources) {
    const text = source.trim();
    if (text === '') continue;
    const result = evaluateExpression(text, scope);
    if (result.error !== undefined) {
      errors.push(`${text}：${result.error}`);
      continue;
    }
    if (!truthy(result.value)) return { ok: false, errors };
  }
  return { ok: errors.length === 0, errors };
}

/** 条件值的真值规则（与常见语言一致：false/0/空串/空数组/null/undefined 为假）。 */
export function truthy(value: ExprValue): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value !== '';
}

/** 把运行时变量摊平成求值作用域：会话变量 + 各角色变量（角色变量优先，后写的覆盖先写的）。 */
export function flattenScope(
  variables: Readonly<Record<string, Readonly<Record<string, ExprValue>>>>,
  characterIds: readonly string[],
): ExprScope {
  const scope: Record<string, ExprValue> = { ...(variables['session'] ?? {}) };
  for (const characterId of characterIds) {
    for (const [name, value] of Object.entries(variables[`character:${characterId}`] ?? {})) {
      if (!Object.hasOwn(scope, name)) scope[name] = value;
    }
  }
  return scope;
}
