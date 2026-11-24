import { open, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fields, text, list, branch, branchList, objectId } from '../validation.mjs';
import { normalizeRemoteUrl, assertRemoteDestinations } from '../remote.mjs';
import { DEFAULT_TEMPORARY_PREFIXES } from '../plan.mjs';
import { fail } from '../errors.mjs';

const MAX_BYTES = 1024 * 1024;

function cancelled(signal) {
  if (signal?.aborted) fail('ERR_ABORTED', 'Configuration loading was cancelled.');
}

// JSON.parse establishes grammar first. This second pass rejects duplicate keys
// (including escaped aliases) and bounds nesting without executing any input.
export function unambiguousJson(source) {
  let value;
  try { value = JSON.parse(source); }
  catch { fail('ERR_CONFIG_JSON', 'Configuration must contain valid UTF-8 JSON.'); }
  const stack = [];
  for (const match of source.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]|[^\s{}\[\],:"]+/gu)) {
    const token = match[0], current = stack.at(-1);
    if (token === '{' || token === '[') {
      stack.push({ keys: token === '{' ? new Set() : null, key: true });
      if (stack.length > 32) fail('ERR_CONFIG_JSON', 'Configuration nesting exceeds the supported limit.');
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (current?.keys) current.key = true; }
    else if (token.startsWith('"') && current?.keys && current.key) {
      const key = JSON.parse(token);
      if (current.keys.has(key)) fail('ERR_CONFIG_JSON', 'Configuration contains duplicate object keys.');
      current.keys.add(key); current.key = false;
    }
  }
  return value;
}

/** JSON data only: no imports, environment interpolation or executable hooks. */
function configuration(value) {
  const data = fields(value, ['schemaVersion', 'repository', 'expectedRemoteUrls', 'remote', 'integrationBranch',
    'permanent', 'reviewedHeads', 'temporaryPrefixes', 'timeoutMs', 'maxOutputBytes'], 'Configuration');
  if (data.schemaVersion !== 1) fail('ERR_CONFIG_SCHEMA', 'Use configuration schemaVersion 1.');
  const repository = text(data.repository, 'Repository identity');
  const expectedRemoteUrls = list(data.expectedRemoteUrls, 'Expected remote URLs', 8).map(normalizeRemoteUrl);
  assertRemoteDestinations({ expectedRemoteUrls, fetchUrls: expectedRemoteUrls.slice(0, 1), pushUrls: expectedRemoteUrls.slice(0, 1) });
  const remote = data.remote === undefined ? 'origin' : text(data.remote, 'Remote name', 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(remote) || remote.includes('..')) fail('ERR_INPUT', 'Use a supported simple remote name.');
  const integrationBranch = branch(data.integrationBranch, 'Integration branch');
  const permanent = branchList(data.permanent, 'Permanent branches');
  if (!permanent.includes(integrationBranch)) fail('ERR_INPUT', 'The integration branch must be permanent.');
  const temporaryPrefixes = list(data.temporaryPrefixes === undefined ? DEFAULT_TEMPORARY_PREFIXES : data.temporaryPrefixes, 'Temporary prefixes').map(prefix => {
    text(prefix, 'Temporary prefix');
    if (!prefix.endsWith('/')) fail('ERR_INPUT', 'Each temporary prefix must end with a slash.');
    branch(prefix.slice(0, -1), 'Temporary prefix'); return prefix;
  });
  if (!temporaryPrefixes.length || new Set(temporaryPrefixes).size !== temporaryPrefixes.length) fail('ERR_INPUT', 'Supply distinct temporary prefixes.');
  const reviewedHeads = list(data.reviewedHeads === undefined ? [] : data.reviewedHeads, 'Reviewed heads', 10000).map(item => {
    const review = fields(item, ['repository', 'branch', 'head', 'target', 'evidence'], 'Reviewed head');
    const format = typeof review.head === 'string' && review.head.length === 64 ? 'sha256' : 'sha1';
    return { repository: text(review.repository, 'Reviewed repository'), branch: branch(review.branch, 'Reviewed branch'),
      head: objectId(review.head, format, 'Reviewed head'), target: objectId(review.target, format, 'Reviewed target'),
      evidence: text(review.evidence, 'Review evidence reference', 2048) };
  });
  const identities = reviewedHeads.map(({ repository, branch, head, target }) => JSON.stringify([repository, branch, head, target]));
  if (new Set(identities).size !== identities.length) fail('ERR_INPUT', 'Duplicate reviewed-head identities are ambiguous.');
  const timeoutMs = data.timeoutMs === undefined ? 10000 : data.timeoutMs;
  const maxOutputBytes = data.maxOutputBytes === undefined ? 4 * 1024 * 1024 : data.maxOutputBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16 * 1024 * 1024) fail('ERR_INPUT', 'Supply supported inspection limits.');
  return { repository, expectedRemoteUrls, remote, integrationBranch, permanent, temporaryPrefixes, reviewedHeads, timeoutMs, maxOutputBytes };
}

/** Read a bounded regular file, refusing a symlink as the final path component. */
export async function readRetirementConfig(file, input = {}) {
  text(file, 'Configuration file', 4096);
  const { signal } = fields(input, ['signal'], 'Configuration read options');
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('ERR_INPUT', 'Supply a valid AbortSignal.');
  cancelled(signal);
  // Fail closed on platforms without these POSIX regular-file protections.
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW <= 0
      || !Number.isInteger(constants.O_NONBLOCK) || constants.O_NONBLOCK <= 0) fail('ERR_CONFIG_FILE', 'This platform lacks the required configuration-file protections.');
  let handle;
  try {
    handle = await open(resolve(file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) fail('ERR_CONFIG_FILE', 'Configuration must be a regular file.');
    if (before.size > BigInt(MAX_BYTES)) fail('ERR_CONFIG_LIMIT', 'Configuration exceeds the 1 MiB limit.');
    const chunks = []; let bytes = 0;
    while (true) {
      cancelled(signal);
      const buffer = Buffer.alloc(Math.min(65536, MAX_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead)); bytes += bytesRead;
      if (bytes > MAX_BYTES) fail('ERR_CONFIG_LIMIT', 'Configuration exceeds the 1 MiB limit.');
    }
    const after = await handle.stat({ bigint: true });
    if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key]) || after.size !== BigInt(bytes)) fail('ERR_CONFIG_CHANGED', 'Configuration changed while being read; retry from stable data.');
    cancelled(signal);
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)); }
    catch { fail('ERR_CONFIG_JSON', 'Configuration must contain valid UTF-8 JSON.'); }
    return configuration(unambiguousJson(source));
  } catch (error) {
    if (error.code?.startsWith('ERR_')) throw error;
    fail('ERR_CONFIG_FILE', 'Configuration could not be read as a regular file.');
  } finally {
    try { await handle?.close(); }
    catch { fail('ERR_CONFIG_FILE', 'Configuration file could not be closed.'); }
  }
}
