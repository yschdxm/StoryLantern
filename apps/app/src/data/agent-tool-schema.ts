/**
 * 工具参数的 JSON Schema 子集 + **手写**校验（不引第三方校验库）。
 *
 * 为什么只支持子集：工具参数是给模型填的，真正需要的是"类型/必填/长度/范围/枚举"这几件；
 * 引入完整 JSON Schema 校验器会把运行时零依赖的规则破坏掉（AGENTS.md 硬约束）。
 * 未识别的关键字一律忽略，但类型不符会明确报错（不静默放行）。
 */

export interface AgentJsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: AgentJsonSchema;
  properties?: Readonly<Record<string, AgentJsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkType(schema: AgentJsonSchema, value: unknown, path: string, errors: string[]): void {
  switch (schema.type) {
    case undefined:
      return;
    case 'object':
      if (!isPlainObject(value)) errors.push(`${path} 必须是对象`);
      return;
    case 'string':
      if (typeof value !== 'string') errors.push(`${path} 必须是字符串`);
      else {
        if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} 至少 ${schema.minLength} 个字符`);
        if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} 最多 ${schema.maxLength} 个字符`);
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path} 必须是数字`);
      else checkRange(schema, value, path, errors);
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) errors.push(`${path} 必须是整数`);
      else checkRange(schema, value, path, errors);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path} 必须是布尔值`);
      return;
    case 'array':
      if (!Array.isArray(value)) errors.push(`${path} 必须是数组`);
      else {
        if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} 至少 ${schema.minItems} 项`);
        if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} 最多 ${schema.maxItems} 项`);
        if (schema.items !== undefined) value.forEach((item, index) => checkType(schema.items ?? {}, item, `${path}[${index}]`, errors));
      }
  }
}

function checkRange(schema: AgentJsonSchema, value: number, path: string, errors: string[]): void {
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} 不能小于 ${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} 不能大于 ${schema.maximum}`);
}

function checkEnum(schema: AgentJsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.enum !== undefined && !schema.enum.includes(value as string | number | boolean)) {
    errors.push(`${path} 必须是 ${schema.enum.map((item) => JSON.stringify(item)).join(' / ')} 之一`);
  }
}

/** 校验一个值；返回错误列表（空数组 = 通过）。 */
export function validateAgentArgs(schema: AgentJsonSchema, value: unknown, path = '参数'): string[] {
  const errors: string[] = [];
  checkType(schema, value, path, errors);
  checkEnum(schema, value, path, errors);
  if (schema.type === 'object' && isPlainObject(value) && schema.properties !== undefined) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key} 必填`);
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (value[key] !== undefined) {
        errors.push(...validateAgentArgs(child, value[key], `${path}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (schema.properties[key] === undefined) errors.push(`${path}.${key} 不是允许的参数`);
      }
    }
  }
  return errors;
}
