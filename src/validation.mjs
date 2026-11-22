import { fail } from './errors.mjs';

export const LIMITS = Object.freeze({ refs: 10000, reviews: 10000, branches: 100, text: 1024, evidence: 2048 });

/** Copy ordinary data properties before awaiting caller-supplied code. */
export function record(value, label, limit = LIMITS.refs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('ERR_INPUT', `${label} must be a plain data object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > limit) fail('ERR_INPUT', `${label} exceeds the supported entry limit.`);
  const copy = Object.create(null);
  for (const key of keys) {
    const entry = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !entry || !Object.hasOwn(entry, 'value')) {
      fail('ERR_INPUT', `${label} must contain only string-keyed data properties.`);
    }
    copy[key] = entry.value;
  }
  return copy;
}

export function fields(value, allowed, label, limit = allowed.length) {
  const copy = record(value, label, limit);
  if (Object.keys(copy).some(key => !allowed.includes(key))) fail('ERR_INPUT', `${label} contains an unsupported field.`);
  return copy;
}

export function list(value, label, max = LIMITS.branches) {
  if (!Array.isArray(value) || value.length > max) fail('ERR_INPUT', `${label} must be an array within the supported limit.`);
  const result = [];
  for (let i = 0; i < value.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (!entry || !Object.hasOwn(entry, 'value')) fail('ERR_INPUT', `${label} must be a dense array of data values.`);
    result.push(entry.value);
  }
  return result;
}

export function text(value, label, max = LIMITS.text) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()
      || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('ERR_INPUT', `${label} must be bounded, nonempty text without control characters or surrounding whitespace.`);
  }
  return value;
}

export function branch(value, label = 'Branch') {
  text(value, label);
  if (value === '@' || value.startsWith('-') || value.endsWith('.') || value.includes('..')
      || value.includes('@{') || /[\s~^:?*\[\\]/u.test(value)
      || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    fail('ERR_INPUT', `${label} is not a supported short Git branch name.`);
  }
  return value;
}

export function branchList(value, label, minimum = 1) {
  const result = list(value, label).map(item => branch(item, label));
  if (result.length < minimum || new Set(result).size !== result.length) {
    fail('ERR_INPUT', `${label} must contain distinct branch names.`);
  }
  return result;
}

export function objectFormat(value = 'sha1') {
  if (!['sha1', 'sha256'].includes(value)) fail('ERR_INPUT', 'Choose the sha1 or sha256 object format.');
  return value;
}

export function objectId(value, format, label = 'Commit ID') {
  const pattern = format === 'sha1' ? /^[a-f0-9]{40}$/u : /^[a-f0-9]{64}$/u;
  if (typeof value !== 'string' || !pattern.test(value) || /^0+$/u.test(value)) {
    fail('ERR_INPUT', `${label} must be a full, nonzero lowercase commit ID in the selected object format.`);
  }
  return value;
}

export function refMap(value, format, label) {
  const copy = record(value, label);
  for (const [name, sha] of Object.entries(copy)) {
    branch(name, label);
    objectId(sha, format, label);
  }
  return copy;
}
