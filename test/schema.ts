import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A small JSON-schema (draft-07 subset) validator — enough for
 * envelope.schema.json without a runtime dependency — plus the panel rules
 * a schema cannot express (EnvelopeValidator: section byte caps, nesting
 * depth, control characters, UTF-8).
 */
type Schema = Record<string, unknown>;

/** Tests run from the repository root (`npm test`); the compiled copy lives under .test-build. */
const schemaPath = join(process.cwd(), 'test', 'envelope.schema.json');

export const envelopeSchema: Schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Schema;

function resolveRef(ref: string, root: Schema): Schema {
  const parts = ref.replace(/^#\//, '').split('/');
  let current: unknown = root;

  for (const part of parts) {
    current = (current as Record<string, unknown>)[part];
  }

  return current as Schema;
}

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }

  return typeof value;
}

function typeMatches(expected: string, actual: string): boolean {
  return expected === actual || (expected === 'number' && actual === 'integer');
}

export function validate(value: unknown, schema: Schema, root: Schema = schema, path = '$'): string[] {
  const errors: string[] = [];

  if (typeof schema['$ref'] === 'string') {
    return validate(value, resolveRef(schema['$ref'], root), root, path);
  }

  if (Array.isArray(schema['allOf'])) {
    for (const sub of schema['allOf'] as Schema[]) {
      errors.push(...validate(value, sub, root, path));
    }
  }

  if (Array.isArray(schema['anyOf'])) {
    const matched = (schema['anyOf'] as Schema[]).some((sub) => validate(value, sub, root, path).length === 0);

    if (!matched) {
      errors.push(`${path}: matches none of anyOf`);
    }
  }

  if (Array.isArray(schema['enum']) && !(schema['enum'] as unknown[]).some((candidate) => candidate === value)) {
    errors.push(`${path}: not in enum`);
  }

  if (schema['type'] !== undefined) {
    const expected = Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
    const actual = typeOf(value);

    if (!expected.some((type) => typeMatches(type, actual))) {
      errors.push(`${path}: expected ${expected.join('|')}, got ${actual}`);

      return errors;
    }
  }

  if (typeof value === 'string') {
    if (typeof schema['maxLength'] === 'number' && Buffer.byteLength(value, 'utf8') > schema['maxLength']) {
      errors.push(`${path}: longer than ${schema['maxLength']}`);
    }

    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) {
      errors.push(`${path}: shorter than ${schema['minLength']}`);
    }

    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(value)) {
      errors.push(`${path}: does not match ${schema['pattern']}`);
    }
  }

  if (typeof value === 'number' && typeof schema['minimum'] === 'number' && value < schema['minimum']) {
    errors.push(`${path}: below minimum`);
  }

  if (Array.isArray(value)) {
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) {
      errors.push(`${path}: more than ${schema['maxItems']} items`);
    }

    if (typeof schema['items'] === 'object' && schema['items'] !== null) {
      value.forEach((item, index) => errors.push(...validate(item, schema['items'] as Schema, root, `${path}[${index}]`)));
    }
  }

  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>;
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;

    for (const required of (schema['required'] ?? []) as string[]) {
      if (!(required in record)) {
        errors.push(`${path}: missing ${required}`);
      }
    }

    if (typeof schema['maxProperties'] === 'number' && Object.keys(record).length > schema['maxProperties']) {
      errors.push(`${path}: more than ${schema['maxProperties']} properties`);
    }

    for (const [key, item] of Object.entries(record)) {
      if (typeof schema['propertyNames'] === 'object' && schema['propertyNames'] !== null) {
        errors.push(...validate(key, schema['propertyNames'] as Schema, root, `${path}.${key} (name)`));
      }

      if (key in properties) {
        errors.push(...validate(item, properties[key] as Schema, root, `${path}.${key}`));
      } else if (typeof schema['additionalProperties'] === 'object' && schema['additionalProperties'] !== null) {
        errors.push(...validate(item, schema['additionalProperties'] as Schema, root, `${path}.${key}`));
      } else if (schema['additionalProperties'] === false) {
        errors.push(`${path}.${key}: additional property`);
      }
    }
  }

  return errors;
}

/** EnvelopeValidator rules that are not schema-expressible. */
export function panelRuleErrors(envelope: Record<string, unknown>): string[] {
  const errors: string[] = [];

  for (const section of ['runtime', 'framework', 'meta']) {
    const value = envelope[section];

    if (value === undefined) {
      continue;
    }

    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8192) {
      errors.push(`${section}: section larger than 8 KB`);
    }

    errors.push(...boundedTreeErrors(value, 0, section));
  }

  return errors;
}

function boundedTreeErrors(tree: unknown, depth: number, path: string): string[] {
  const errors: string[] = [];

  if (depth > 5) {
    return [`${path}: nested deeper than 5`];
  }

  const entries = Array.isArray(tree) ? tree.map((item, index) => [String(index), item] as const) : Object.entries(tree as Record<string, unknown>);

  if (entries.length > 60) {
    errors.push(`${path}: more than 60 entries`);
  }

  for (const [key, value] of entries) {
    if (!Array.isArray(tree) && !/^[a-z0-9_]{1,40}$/.test(key)) {
      errors.push(`${path}.${key}: invalid key`);
    }

    if (typeof value === 'object' && value !== null) {
      errors.push(...boundedTreeErrors(value, depth + 1, `${path}.${key}`));
    } else if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > 200 || /[\u0000-\u001f\u007f]/.test(value) || Buffer.from(value, 'utf8').toString('utf8') !== value) {
        errors.push(`${path}.${key}: invalid string`);
      }
    } else if (value !== null && typeof value !== 'number' && typeof value !== 'boolean') {
      errors.push(`${path}.${key}: invalid value`);
    }
  }

  return errors;
}

export function validateEnvelope(envelope: unknown): string[] {
  const errors = validate(envelope, envelopeSchema);

  if (typeof envelope === 'object' && envelope !== null) {
    errors.push(...panelRuleErrors(envelope as Record<string, unknown>));
  }

  return errors;
}
