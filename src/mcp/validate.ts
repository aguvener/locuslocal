/**
 * Minimal JSON-Schema validator for the subset of schema we expose to the agent.
 *
 * Tool arguments arrive from a model and are therefore untrusted input, exactly
 * like a query string. Every argument is checked against its declared schema,
 * numbers are clamped into range rather than rejected (an agent guessing
 * `maxFrequency: 5` should get sensible behaviour, not an error), strings are
 * length-capped, and any property not declared in the schema is dropped before
 * it can reach application code.
 */

export interface PropSchema {
  description?: string;
  enum?: readonly string[];
  items?: { type: "string" | "number" | "integer"; enum?: readonly string[] };
  maxItems?: number;
  maximum?: number;
  maxLength?: number;
  minimum?: number;
  type: "string" | "number" | "integer" | "boolean" | "array";
}

export interface ObjectSchema {
  properties: Record<string, PropSchema>;
  required?: readonly string[];
  type: "object";
}

export interface ValidationResult {
  errors: string[];
  notes: string[];
  ok: boolean;
  value: Record<string, unknown>;
}

const MAX_STRING = 200;

export function validate(schema: ObjectSchema, raw: unknown): ValidationResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const value: Record<string, unknown> = {};

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      errors: ["arguments must be a JSON object"],
      notes,
      ok: false,
      value,
    };
  }
  const input = raw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!(key in schema.properties)) {
      notes.push(`ignored unknown argument "${key.slice(0, 40)}"`);
    }
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    const v = input[key];
    if (v === undefined || v === null) {
      if (schema.required?.includes(key)) {
        errors.push(`missing required argument "${key}"`);
      }
      continue;
    }
    const r = coerce(key, prop, v, notes);
    if (r.error) {
      errors.push(r.error);
    } else {
      value[key] = r.value;
    }
  }

  return { errors, notes, ok: errors.length === 0, value };
}

function coerceString(
  key: string,
  prop: PropSchema,
  v: unknown,
  notes: string[]
): CoerceResult {
  if (typeof v !== "string") {
    return { error: `"${key}" must be a string` };
  }
  let out = v;
  const cap = prop.maxLength ?? MAX_STRING;
  if (out.length > cap) {
    out = out.slice(0, cap);
    notes.push(`truncated "${key}" to ${cap} chars`);
  }
  if (prop.enum && !prop.enum.includes(out)) {
    return { error: `"${key}" must be one of: ${prop.enum.join(", ")}` };
  }
  return { value: out };
}

/**
 * `Number("")` and `Number("  ")` are 0, not NaN, so an empty string used to
 * pass the finite check and land on row 0 — meaning `explain_variant({id: ""})`
 * silently answered about an arbitrary marker instead of rejecting the call.
 */
function toNumber(v: unknown): number {
  if (typeof v === "number") {
    return v;
  }
  if (typeof v !== "string" || v.trim() === "") {
    return Number.NaN;
  }
  return Number(v);
}

function coerceNumber(
  key: string,
  prop: PropSchema,
  v: unknown,
  notes: string[]
): CoerceResult {
  const n = toNumber(v);
  if (!Number.isFinite(n)) {
    return { error: `"${key}" must be a number` };
  }
  let out = prop.type === "integer" ? Math.trunc(n) : n;
  if (prop.minimum !== undefined && out < prop.minimum) {
    notes.push(`clamped "${key}" ${out} -> ${prop.minimum}`);
    out = prop.minimum;
  }
  if (prop.maximum !== undefined && out > prop.maximum) {
    notes.push(`clamped "${key}" ${out} -> ${prop.maximum}`);
    out = prop.maximum;
  }
  return { value: out };
}

function coerceBoolean(key: string, v: unknown): CoerceResult {
  if (typeof v === "boolean") {
    return { value: v };
  }
  if (v === "true") {
    return { value: true };
  }
  if (v === "false") {
    return { value: false };
  }
  return { error: `"${key}" must be a boolean` };
}

function coerceArray(
  key: string,
  prop: PropSchema,
  v: unknown,
  notes: string[]
): CoerceResult {
  if (!Array.isArray(v)) {
    return { error: `"${key}" must be an array` };
  }
  const cap = prop.maxItems ?? 50;
  let items: unknown[] = v;
  if (items.length > cap) {
    items = items.slice(0, cap);
    notes.push(`truncated "${key}" to ${cap} items`);
  }
  const itemSchema = (prop.items ?? { type: "string" }) as PropSchema;
  const out: unknown[] = [];
  for (const el of items) {
    const r = coerce(`${key}[]`, itemSchema, el, notes);
    if (r.error) {
      return { error: r.error };
    }
    out.push(r.value);
  }
  return { value: out };
}

interface CoerceResult {
  error?: string;
  value?: unknown;
}

function coerce(
  key: string,
  prop: PropSchema,
  v: unknown,
  notes: string[]
): CoerceResult {
  switch (prop.type) {
    case "string":
      return coerceString(key, prop, v, notes);
    case "number":
    case "integer":
      return coerceNumber(key, prop, v, notes);
    case "boolean":
      return coerceBoolean(key, v);
    case "array":
      return coerceArray(key, prop, v, notes);
    default:
      // An unrecognised schema type is a bug in our own tool definitions, not
      // in the agent's arguments. Fail closed.
      return { error: `"${key}" has an unsupported schema type` };
  }
}
