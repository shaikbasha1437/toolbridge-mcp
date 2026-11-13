/* A small JSON Schema validator for the subset ToolBridge uses (draft 2020-12 keywords: type, properties,
   required, additionalProperties:false, enum, const, minimum, maximum, minLength, maxLength, pattern,
   format: date | date-time | email, items, minItems, maxItems, oneOf of required-sets via anyOf).
   Identical in Node and the browser, and plugs into the MCP SDK as a `jsonSchemaValidator`. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function typeOf(v) { if (v === null) return 'null'; if (Array.isArray(v)) return 'array'; if (Number.isInteger(v)) return 'integer'; return typeof v; }
function typeOk(t, v) { const a = typeOf(v); return t === a || (t === 'number' && a === 'integer'); }
function check(schema, v, path, errs) {
  if (!schema || typeof schema !== 'object') return;
  const at = path || 'arguments';
  if (schema.type) { const ts = [].concat(schema.type); if (!ts.some((t) => typeOk(t, v))) { errs.push(at + ': expected ' + ts.join(' or ') + ', got ' + typeOf(v)); return; } }
  if (schema.const !== undefined && v !== schema.const) errs.push(at + ': must be ' + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.includes(v)) errs.push(at + ': must be one of ' + schema.enum.map((x) => JSON.stringify(x)).join(', '));
  if (typeof v === 'number') {
    if (schema.minimum != null && v < schema.minimum) errs.push(at + ': must be >= ' + schema.minimum);
    if (schema.maximum != null && v > schema.maximum) errs.push(at + ': must be <= ' + schema.maximum);
  }
  if (typeof v === 'string') {
    if (schema.minLength != null && v.length < schema.minLength) errs.push(at + ': must be at least ' + schema.minLength + ' characters');
    if (schema.maxLength != null && v.length > schema.maxLength) errs.push(at + ': must be at most ' + schema.maxLength + ' characters');
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(at + ': must match ' + schema.pattern + (schema.examples ? ' (e.g. ' + schema.examples[0] + ')' : ''));
    if (schema.format === 'date' && !DATE.test(v)) errs.push(at + ': must be a date like 2026-11-13');
    if (schema.format === 'date-time' && !DATETIME.test(v)) errs.push(at + ': must be an ISO 8601 date-time like 2026-11-13T15:00:00Z');
    if (schema.format === 'email' && !EMAIL.test(v)) errs.push(at + ': must be an email address');
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(at + ': needs at least ' + schema.minItems + ' items');
    if (schema.maxItems != null && v.length > schema.maxItems) errs.push(at + ': allows at most ' + schema.maxItems + ' items');
    if (schema.items) v.forEach((x, i) => check(schema.items, x, at + '[' + i + ']', errs));
  }
  if (typeOf(v) === 'object') {
    const props = schema.properties || {};
    (schema.required || []).forEach((k) => { if (v[k] === undefined) errs.push(at + '.' + k + ': is required'); });
    Object.keys(v).forEach((k) => {
      if (props[k]) check(props[k], v[k], at + '.' + k, errs);
      else if (schema.additionalProperties === false) errs.push(at + '.' + k + ': unknown field (allowed: ' + Object.keys(props).join(', ') + ')');
    });
    if (schema.anyOf) {
      const ok = schema.anyOf.some((sub) => { const e = []; check(sub, v, at, e); return !e.length; });
      if (!ok) errs.push(at + ': ' + (schema['x-anyOfMessage'] || 'does not match any allowed shape'));
    }
  }
}
export function validate(schema, value) {
  const errs = []; check(schema, value === undefined ? {} : value, '', errs);
  return errs.length ? { valid: false, data: undefined, errorMessage: errs.join('; '), errors: errs } : { valid: true, data: value === undefined ? {} : value, errorMessage: undefined, errors: [] };
}
/* Adapter for the MCP SDK's fromJsonSchema(schema, validator). onInvalid lets the caller audit rejected input. */
export function sdkValidator(onInvalid) {
  return { getValidator(schema) { return (input) => { const r = validate(schema, input); if (!r.valid && onInvalid) onInvalid(input, r.errorMessage); return r.valid ? { valid: true, data: r.data, errorMessage: undefined } : { valid: false, data: undefined, errorMessage: r.errorMessage }; }; } };
}
