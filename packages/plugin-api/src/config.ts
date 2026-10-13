import type { ConfigResult } from './contract.ts';

export interface NodeBase {
  default?: unknown;
  description?: string;
}

export interface StringNode extends NodeBase {
  type: 'string';
  default?: string;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
}

export interface NumberNode extends NodeBase {
  type: 'number';
  default?: number;
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface BooleanNode extends NodeBase {
  type: 'boolean';
  default?: boolean;
}

export interface LiteralNode extends NodeBase {
  type: 'literal';
  value: string | number | boolean | null;
}

export interface ArrayNode extends NodeBase {
  type: 'array';
  items: SchemaNode;
  default?: readonly unknown[];
  maxItems?: number;
}

export interface ObjectNode extends NodeBase {
  type: 'object';
  dict: Record<string, SchemaNode>;
  default?: Record<string, unknown>;
}

export interface UnionNode extends NodeBase {
  type: 'union';
  anyOf: readonly SchemaNode[];
}

export type SchemaNode =
  | StringNode
  | NumberNode
  | BooleanNode
  | LiteralNode
  | ArrayNode
  | ObjectNode
  | UnionNode;

export interface SchemaDictionary {
  readonly kind: 'schema';
  readonly dict: Record<string, SchemaNode>;
  validate(value: unknown): ConfigResult;
  defaults(): Record<string, unknown>;
  toJsonSchema(): Record<string, unknown>;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function validateNode(node: SchemaNode, value: unknown, path: string, errors: string[]): unknown {
  switch (node.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${path}: 期望 string，实际 ${typeName(value)}`);
        return node.default;
      }
      if (node.enum && !node.enum.includes(value)) {
        errors.push(`${path}: 取值必须是 ${node.enum.join(' | ')}，实际 '${value}'`);
        return node.default;
      }
      if (node.minLength !== undefined && value.length < node.minLength) {
        errors.push(`${path}: 长度需 ≥ ${node.minLength}`);
      }
      if (node.maxLength !== undefined && value.length > node.maxLength) {
        errors.push(`${path}: 长度需 ≤ ${node.maxLength}`);
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push(`${path}: 期望 number，实际 ${typeName(value)}`);
        return node.default;
      }
      if (node.integer && !Number.isInteger(value)) errors.push(`${path}: 需为整数`);
      if (node.min !== undefined && value < node.min) errors.push(`${path}: 需 ≥ ${node.min}`);
      if (node.max !== undefined && value > node.max) errors.push(`${path}: 需 ≤ ${node.max}`);
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push(`${path}: 期望 boolean，实际 ${typeName(value)}`);
        return node.default;
      }
      return value;
    }
    case 'literal': {
      if (value !== node.value) {
        errors.push(`${path}: 期望字面量 ${JSON.stringify(node.value)}，实际 ${JSON.stringify(value)}`);
        return node.default;
      }
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: 期望 array，实际 ${typeName(value)}`);
        return node.default;
      }
      if (node.maxItems !== undefined && value.length > node.maxItems) {
        errors.push(`${path}: 元素数需 ≤ ${node.maxItems}`);
      }
      return value.map((item, index) => validateNode(node.items, item, `${path}[${index}]`, errors));
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: 期望 object，实际 ${typeName(value)}`);
        return node.default;
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.dict)) {
        const childPath = path === '' ? key : `${path}.${key}`;
        if (key in input) {
          const validated = validateNode(child, input[key], childPath, errors);
          if (validated !== undefined) out[key] = validated;
        } else if ('default' in child) {
          // 默认值也要过校验，否则嵌套默认值不会被补齐。
          const validated = validateNode(child, child.default, childPath, errors);
          out[key] = validated === undefined ? child.default : validated;
        }
      }
      return out;
    }
    case 'union': {
      for (const candidate of node.anyOf) {
        const probe: string[] = [];
        const validated = validateNode(candidate, value, path, probe);
        if (probe.length === 0) return validated;
      }
      errors.push(`${path}: 不匹配任何允许的类型`);
      return node.default;
    }
    default: {
      const exhaustive: never = node;
      void exhaustive;
      errors.push(`${path}: 未知 schema 节点`);
      return undefined;
    }
  }
}

/** 未在 schema 中声明的键：保留原值但记入 warnings（向前兼容，绝不静默丢弃数据）。 */
function collectUnknown(node: ObjectNode, value: unknown, path: string, warnings: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const extra: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!(key in node.dict)) {
      const label = path === '' ? key : `${path}.${key}`;
      warnings.push(`${label}: 未声明的配置键（已保留原值）`);
      extra[key] = (value as Record<string, unknown>)[key];
    }
  }
  return extra;
}

/**
 * 定义一个 Config schema。规则：
 *  - 有 `default` 的字段可省略；
 *  - 无 `default` 且缺失 → 只是不出现，不报错（可选字段）；
 *  - 未知键保留并记 warning（向前兼容）。
 */
export function defineConfig(dict: Record<string, SchemaNode>): SchemaDictionary {
  const root: ObjectNode = { type: 'object', dict };

  const schema: SchemaDictionary = {
    kind: 'schema',
    dict,
    validate(value: unknown): ConfigResult {
      const errors: string[] = [];
      const warnings: string[] = [];
      if (value === undefined || value === null) {
        return { ok: true, value: schema.defaults(), errors, warnings };
      }
      const base = validateNode(root, value, '', errors) as Record<string, unknown> | undefined;
      const merged = { ...(base ?? {}), ...collectUnknown(root, value, '', warnings) };
      return { ok: errors.length === 0, value: merged, errors, warnings };
    },
    defaults(): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      for (const [key, node] of Object.entries(dict)) {
        if ('default' in node && node.default !== undefined) out[key] = node.default;
      }
      return out;
    },
    toJsonSchema(): Record<string, unknown> {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, node] of Object.entries(dict)) {
        properties[key] = nodeToJsonSchema(node);
        if (!('default' in node)) required.push(key);
      }
      return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: true,
      };
    },
  };
  return schema;
}

function nodeToJsonSchema(node: SchemaNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (node.type) {
    case 'string':
      out.type = 'string';
      if (node.enum) out.enum = node.enum;
      if (node.minLength !== undefined) out.minLength = node.minLength;
      if (node.maxLength !== undefined) out.maxLength = node.maxLength;
      break;
    case 'number':
      out.type = node.integer ? 'integer' : 'number';
      if (node.min !== undefined) out.minimum = node.min;
      if (node.max !== undefined) out.maximum = node.max;
      break;
    case 'boolean':
      out.type = 'boolean';
      break;
    case 'literal':
      out.const = node.value;
      break;
    case 'array':
      out.type = 'array';
      out.items = nodeToJsonSchema(node.items);
      if (node.maxItems !== undefined) out.maxItems = node.maxItems;
      break;
    case 'object': {
      const properties: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node.dict)) properties[key] = nodeToJsonSchema(child);
      out.type = 'object';
      out.properties = properties;
      out.additionalProperties = true;
      break;
    }
    case 'union':
      out.anyOf = node.anyOf.map(nodeToJsonSchema);
      break;
  }
  if ('description' in node && node.description !== undefined) out.description = node.description;
  if ('default' in node && node.default !== undefined) out.default = node.default;
  return out;
}
