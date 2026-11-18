// Parameter validation for registered methods. A method declares `params: { name: spec }`; `validate(schema, params)`
// returns a new object with defaults applied or throws EngineError('invalid_params', …, { param, reason }).
//
// spec is a type name ('path', 'rev?' — a trailing '?' means optional) or an object
//   { type, optional, default, min, max, values (enum), maxItems (arrays), props (object), maxLength }.
// Types:
//   string   any string (maxLength default 1 MiB)          bool, int, number
//   enum     one of `values`
//   oid      object id, 4–64 lower-case hex (abbreviated ids allowed)
//   oids     array of oid (maxItems default 200 000)
//   rev      a revision: no leading '-' or '^', no whitespace, ':', '..', '\\', '*', '?', '['. Passed after
//            --end-of-options.
//   path     repository-relative path: not absolute, no '.'/'..' segments, not inside .git, no NUL (one trailing '/'
//            is allowed: a folder, as git status names an untracked nested repository)
//   paths    array of path
//   object   plain object checked with `props` (unknown keys refused)
//   any      anything JSON
// Unknown parameters are refused, so a misspelled UI parameter fails loudly instead of being ignored.
import { EngineError } from './errors.js';

const bad = (param, reason) => { throw new EngineError('invalid_params', 'invalid parameter ' + param + ': ' + reason, { param, reason }); };

export function normalizeSpec(spec) {
  if (typeof spec === 'string') {
    const optional = spec.endsWith('?');
    return { type: optional ? spec.slice(0, -1) : spec, optional };
  }
  return spec;
}

export function isRev(v) {
  // A leading '^' would turn a revision into an exclusion ("^HEAD": everything NOT in HEAD); no ref name has one.
  return typeof v === 'string' && v.length > 0 && v.length <= 512 && !v.startsWith('-') && !v.startsWith('^') &&
    !/[\s\0:\\*?[\x7f]/.test(v) && !v.includes('..') && !/[\x00-\x1f]/.test(v);
}

export function checkPath(v, param = 'path') {
  if (typeof v !== 'string' || !v) bad(param, 'must be a non-empty string');
  if (v.includes('\0')) bad(param, 'contains NUL');
  if (v.length > 4096) bad(param, 'too long');
  if (v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)) bad(param, 'must be relative to the repository root');
  // One trailing '/' names a folder, as git status lists an untracked nested repository ("nested/").
  const parts = (v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v).split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) bad(param, 'must be a normalized relative path');
  if (parts.some((p) => p.toLowerCase() === '.git')) bad(param, 'must not point into .git');
  return v;
}

function check(spec, value, param) {
  const s = normalizeSpec(spec);
  if (value === undefined || value === null) {
    if (s.default !== undefined) return typeof s.default === 'function' ? s.default() : s.default;
    if (s.optional) return undefined;
    bad(param, 'is required');
  }
  switch (s.type) {
    case 'string':
      if (typeof value !== 'string') bad(param, 'must be a string');
      if (value.length > (s.maxLength || 1024 * 1024)) bad(param, 'too long');
      if (s.nonEmpty && !value) bad(param, 'must not be empty');
      return value;
    case 'bool':
      if (typeof value !== 'boolean') bad(param, 'must be true or false');
      return value;
    case 'int':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (s.type === 'int' && !Number.isInteger(value))) bad(param, 'must be ' + (s.type === 'int' ? 'an integer' : 'a number'));
      if (s.min !== undefined && value < s.min) bad(param, 'must be >= ' + s.min);
      if (s.max !== undefined && value > s.max) bad(param, 'must be <= ' + s.max);
      return value;
    case 'enum':
      if (!s.values.includes(value)) bad(param, 'must be one of ' + s.values.join(', '));
      return value;
    case 'oid':
      if (typeof value !== 'string' || !/^[0-9a-f]{4,64}$/.test(value)) bad(param, 'must be a hex object id');
      return value;
    case 'rev':
      if (!isRev(value)) bad(param, 'is not an allowed revision');
      return value;
    case 'path':
      return checkPath(value, param);
    case 'oids':
    case 'paths': {
      if (!Array.isArray(value)) bad(param, 'must be an array');
      if (value.length > (s.maxItems || 200000)) bad(param, 'has too many items');
      const item = s.type === 'oids' ? 'oid' : 'path';
      return value.map((v, i) => check(item, v, param + '[' + i + ']'));
    }
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) bad(param, 'must be an object');
      return validate(s.props || {}, value, param + '.');
    case 'any':
      return value;
    default:
      throw new EngineError('internal', 'unknown parameter type ' + s.type);
  }
}

export function validate(schema, params, prefix = '') {
  const input = params == null ? {} : params;
  if (typeof input !== 'object' || Array.isArray(input)) bad(prefix || 'params', 'must be an object');
  const out = {};
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) bad(prefix + key, 'is not a parameter of this method');
  }
  for (const [key, spec] of Object.entries(schema)) {
    const v = check(spec, input[key], prefix + key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}
