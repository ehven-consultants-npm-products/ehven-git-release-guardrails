import { realpath, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fields, list, text, branch, branchList, objectFormat, objectId } from '../validation.mjs';
import { fail } from '../errors.mjs';
import { assertRemoteDestinations, normalizeRemoteUrl } from '../remote.mjs';
import { planRetirements } from '../plan.mjs';
import { gitReader } from './process.mjs';
import { readLiveAuthorization, validateAdvertisements } from './live-remote.mjs';

function lines(value) { return value === '' ? [] : value.replace(/\n$/u, '').split('\n'); }

function refs(value, remote, format, permanent) {
  const local = Object.create(null), tracking = Object.create(null);
  for (const line of lines(value)) {
    const parts = line.split('\0');
    if (parts.length !== 3) fail('ERR_GIT_PARSE', 'Git returned malformed ref data.');
    const [name, sha, symbolic] = parts;
    if (name === `refs/remotes/${remote}/HEAD` && symbolic) {
      if (permanent && !permanent.some(branch => symbolic === `refs/remotes/${remote}/${branch}`)) {
        fail('ERR_SYMBOLIC_REF', 'The remote-tracking HEAD must point to a permanent branch for execution.');
      }
      continue;
    }
    if (symbolic) fail('ERR_SYMBOLIC_REF', 'A branch ref is symbolic; review it before retirement.');
    const map = name.startsWith('refs/heads/') ? local : name.startsWith(`refs/remotes/${remote}/`) ? tracking : undefined;
    if (!map) fail('ERR_GIT_PARSE', 'Git returned an unexpected ref namespace.');
    const short = name.slice(map === local ? 'refs/heads/'.length : `refs/remotes/${remote}/`.length);
    branch(short); objectId(sha, format);
    if (Object.hasOwn(map, short)) fail('ERR_GIT_PARSE', 'Git returned duplicate branch refs.');
    map[short] = sha;
  }
  return { local, remote: tracking };
}

function worktrees(value, root, head, integration, format) {
  const records = []; let record = Object.create(null);
  for (const item of value.split('\0')) {
    if (!item) { if (Object.keys(record).length) records.push(record); record = Object.create(null); continue; }
    const index = item.indexOf(' '), key = index < 0 ? item : item.slice(0, index), data = index < 0 ? true : item.slice(index + 1);
    if (!['worktree', 'HEAD', 'branch', 'bare', 'detached', 'locked', 'prunable'].includes(key) || Object.hasOwn(record, key)) {
      fail('ERR_GIT_PARSE', 'Git returned unsupported worktree data.');
    }
    record[key] = data;
  }
  if (Object.keys(record).length) records.push(record);
  if (records.length !== 1 || records[0].worktree !== root || records[0].branch !== `refs/heads/${integration}`
      || records[0].HEAD !== head || ['bare', 'detached', 'locked', 'prunable'].some(key => Object.hasOwn(records[0], key))) {
    fail('ERR_WORKTREE', 'Require one clean attached worktree; linked, detached or uncertain worktrees need review.');
  }
  objectId(records[0].HEAD, format);
  return [{ path: root, branch: integration, head }];
}

/** Local-cache inspection only. */
export async function inspectRetirements(input) { return (await inspectRetirementState(input)).result; }

/** Read-only live comparison against the effective fetch and push endpoints. */
export async function validateLiveRetirement(input) { return (await inspectRetirementState(input, { live: true })).result; }

export function retirementPlanId(state) {
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

export async function inspectRetirementState(input, { live = false, execution = false } = {}) {
  const keys = ['cwd', 'repository', 'expectedRemoteUrls', 'remote', 'integrationBranch', 'permanent', 'reviewedHeads', 'temporaryPrefixes', 'timeoutMs', 'maxOutputBytes', 'signal'];
  if (live || execution) keys.push('httpsAuthorization');
  const options = fields(input, keys, 'Inspection options');
  const authorization = live || execution ? readLiveAuthorization(options.httpsAuthorization) : undefined;
  const cwd = text(options.cwd, 'Repository root', 4096);
  const repository = text(options.repository, 'Repository identity');
  const remote = options.remote === undefined ? 'origin' : text(options.remote, 'Remote name', 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(remote) || remote.includes('..')) fail('ERR_INPUT', 'Use a supported simple remote name.');
  const integration = branch(options.integrationBranch, 'Integration branch');
  const permanent = branchList(options.permanent, 'Permanent branches');
  if (!permanent.includes(integration)) fail('ERR_INPUT', 'The integration branch must be permanent.');
  // Validate expected endpoints before starting a subprocess; preserve an owned snapshot.
  const approved = list(options.expectedRemoteUrls, 'Expected remote URLs', 8);
  const expectedRemoteUrls = approved.map(normalizeRemoteUrl);
  assertRemoteDestinations({ expectedRemoteUrls, fetchUrls: expectedRemoteUrls.slice(0, 1), pushUrls: expectedRemoteUrls.slice(0, 1) });
  const reviewedHeads = options.reviewedHeads === undefined ? undefined : list(options.reviewedHeads, 'Reviewed heads', 10000)
    .map(item => fields(item, ['repository', 'branch', 'head', 'target', 'evidence'], 'Reviewed head'));
  const temporaryPrefixes = options.temporaryPrefixes === undefined ? undefined : list(options.temporaryPrefixes, 'Temporary prefixes');
  const timeoutMs = options.timeoutMs === undefined ? 10000 : options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes === undefined ? 4 * 1024 * 1024 : options.maxOutputBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16 * 1024 * 1024
      || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) fail('ERR_INPUT', 'Supply supported inspection limits and an optional AbortSignal.');
  if (options.signal?.aborted) fail('ERR_ABORTED', 'Inspection was cancelled.');
  let root;
  try { root = await realpath(resolve(cwd)); } catch { fail('ERR_REPOSITORY_PATH', 'The supplied repository root is unavailable.'); }
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  const run = gitReader({ cwd: root, timeoutMs, maxOutputBytes, signal });
  if ((await run(['rev-parse', '--is-inside-work-tree'])).stdout.trim() !== 'true'
      || (await run(['rev-parse', '--is-bare-repository'])).stdout.trim() !== 'false') fail('ERR_REPOSITORY', 'Require a non-bare Git working tree.');
  let top;
  try { top = await realpath((await run(['rev-parse', '--show-toplevel'])).stdout.trim()); }
  catch (error) { if (error.code?.startsWith('ERR_')) throw error; fail('ERR_REPOSITORY_PATH', 'The Git working tree root is unavailable.'); }
  if (top !== root) fail('ERR_REPOSITORY_ROOT', 'Run inspection from the repository root.');
  if ((await run(['rev-parse', '--is-shallow-repository'])).stdout.trim() !== 'false') fail('ERR_SHALLOW_HISTORY', 'Full Git history is required.');
  const format = objectFormat((await run(['rev-parse', '--show-object-format'])).stdout.trim());
  if ((await run(['for-each-ref', '--format=%(refname)', 'refs/replace/'])).stdout) fail('ERR_REPLACED_HISTORY', 'Replacement refs require review before retirement.');
  const graft = resolve(root, (await run(['rev-parse', '--git-path', 'info/grafts'])).stdout.trim());
  try { const info = await lstat(graft); if (!info.isFile() || info.size !== 0) fail('ERR_REPLACED_HISTORY', 'Grafted or uncertain history requires review before retirement.'); }
  catch (error) { if (error.code?.startsWith('ERR_')) throw error; if (error.code !== 'ENOENT') fail('ERR_INSPECTION_FS', 'Git history metadata could not be inspected.'); }
  const partial = await run(['config', '--get', 'extensions.partialClone'], [0, 1]);
  const promisors = await run(['config', '--type=bool', '--get-regexp', '^remote\..*\.promisor$'], [0, 1]);
  if (partial.status === 0 || lines(promisors.stdout).some(line => !line.endsWith(' false'))) fail('ERR_PARTIAL_HISTORY', 'Partial/promisor repositories are unsupported for retirement inspection.');
  const filters = await run(['config', '--get-regexp', '^filter\..*\.(clean|process|smudge)$'], [0, 1]);
  if (filters.stdout) fail('ERR_EXTERNAL_FILTER', 'Executable content filters need review before status inspection.');

  async function transport() {
    const fetchUrls = lines((await run(['remote', 'get-url', '--all', remote])).stdout);
    const pushUrls = lines((await run(['remote', 'get-url', '--push', '--all', remote])).stdout);
    const destinations = assertRemoteDestinations({ expectedRemoteUrls, fetchUrls, pushUrls });
    const fetch = lines((await run(['config', '--get-all', `remote.${remote}.fetch`], [0, 1])).stdout);
    const expected = `refs/heads/*:refs/remotes/${remote}/*`;
    if (fetch.length !== 1 || ![expected, '+' + expected].includes(fetch[0])) fail('ERR_FETCH_REFSPEC', 'Require one complete branch fetch refspec without exclusions or extra destinations.');
    const mirror = await run(['config', '--type=bool', '--get', `remote.${remote}.mirror`], [0, 1]);
    const push = await run(['config', '--get-all', `remote.${remote}.push`], [0, 1]);
    const tags = await run(['config', '--type=bool', '--get', 'push.followTags'], [0, 1]);
    if ((mirror.status === 0 && mirror.stdout.trim() !== 'false') || push.stdout
        || (tags.status === 0 && tags.stdout.trim() !== 'false')) fail('ERR_PUSH_CONFIGURATION', 'Mirror, implicit push-refspec or follow-tags configuration requires review.');
    return { ...destinations, fetchRefspec: fetch[0], ...(live || execution ? { raw: { fetch: fetchUrls[0], push: pushUrls[0] } } : {}) };
  }
  async function snapshot() {
    const current = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], [0, 1]);
    if (current.status === 1) fail('ERR_DETACHED_SOURCE', 'Use the attached integration branch for retirement inspection.');
    if (current.stdout.trim() !== integration) fail('ERR_SOURCE_BRANCH', 'Use the configured integration branch.');
    const head = objectId((await run(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(), format);
    if ((await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout !== '') fail('ERR_DIRTY_SOURCE', 'Preserve tracked and untracked changes before retirement inspection.');
    const allRefs = (await run(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads/', `refs/remotes/${remote}/`])).stdout;
    const trees = (await run(['worktree', 'list', '--porcelain', '-z'])).stdout;
    return { head, allRefs, trees, transport: await transport() };
  }
  const before = await snapshot();
  const maps = refs(before.allRefs, remote, format, execution ? permanent : undefined);
  if (maps.local[integration] !== before.head || maps.remote[integration] !== before.head) fail('ERR_SOURCE_ALIGNMENT', 'The local integration branch must match its remote-tracking head. Refresh and review separately.');
  const checkedWorktrees = worktrees(before.trees, root, before.head, integration, format);
  const isAncestor = async (head, target) => (await run(['merge-base', '--is-ancestor', head, target], [0, 1])).status === 0;
  const plan = await planRetirements({ repository, permanent, ...maps, reviewedHeads,
    temporaryPrefixes, objectFormat: format, isAncestor });
  const after = await snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('ERR_INSPECTION_CHANGED', 'Git state changed during inspection; settle concurrent work and retry.');
  const { raw, ...publicTransport } = before.transport;
  const result = { inspectionOnly: true, remoteFreshness: 'unverified-local-cache', networkAccess: false, refMutations: false,
    source: { root, branch: integration, head: before.head, objectFormat: format, remote },
    transport: publicTransport, worktrees: checkedWorktrees, plan };
  const state = {
    source: result.source,
    transport: publicTransport,
    raw,
    permanent: [...permanent].sort(),
    refs: { local: Object.entries(maps.local).sort(), tracking: Object.entries(maps.remote).sort() },
    plan,
  };
  const data = { result, state, approved, authorization };
  if (!live) return data;
  const observation = await validateAdvertisements({ raw, approved, authorization, cached: maps.remote, format,
    options: { cwd: root, timeoutMs, maxOutputBytes, signal } });
  if (JSON.stringify(before) !== JSON.stringify(await snapshot())) {
    fail('ERR_INSPECTION_CHANGED', 'Git state changed during live validation; settle concurrent work and retry.');
  }
  return { ...data, result: { ...result, remoteFreshness: 'matched-live-advertisement', networkAccess: true, observation,
    planId: retirementPlanId(state) } };
}
