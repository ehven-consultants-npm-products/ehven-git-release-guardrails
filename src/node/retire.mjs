import { open, realpath, lstat, link, unlink, mkdtemp, rm, constants } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fail } from '../errors.mjs';
import { fields, list, LIMITS, text } from '../validation.mjs';
import { inspectRetirementState, retirementPlanId } from './inspect.mjs';
import { createRetirementBackup, verifyRetirementBackup, assertBackupCoversRetirement } from './backup.mjs';
import { unambiguousJson } from './config.mjs';
import { gitReader, runBounded, GIT_LOCAL_ARGS } from './process.mjs';
import { approvedDestinations, pushRetirements, queryHeads } from './live-remote.mjs';

const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
const ID = /^[a-f0-9]{64}$/u;
const JOURNAL = 'retirement.json';

function parameters(input) {
  const data = fields(input, ['inspection', 'directory', 'expectedPlanId', 'signal', 'timeoutMs', 'maxBackupBytes'], 'Retirement options');
  if (process.platform === 'win32' || !(constants.O_NOFOLLOW > 0) || !(constants.O_NONBLOCK > 0)) {
    fail('ERR_RETIREMENT_PLATFORM', 'Apply and recovery require a supported POSIX filesystem.');
  }
  if (typeof data.expectedPlanId !== 'string' || !ID.test(data.expectedPlanId)) {
    fail('ERR_RETIREMENT_PLAN', 'Supply the full plan ID from an approved live preview.');
  }
  const spec = fields(data.inspection, ['cwd', 'repository', 'expectedRemoteUrls', 'remote', 'integrationBranch',
    'permanent', 'reviewedHeads', 'temporaryPrefixes', 'timeoutMs', 'maxOutputBytes', 'httpsAuthorization'], 'Retirement inspection');
  for (const key of ['permanent', 'temporaryPrefixes', 'expectedRemoteUrls']) {
    if (spec[key] !== undefined) spec[key] = list(spec[key], key);
  }
  if (spec.reviewedHeads !== undefined) {
    spec.reviewedHeads = list(spec.reviewedHeads, 'Reviewed heads', LIMITS.reviews).map(review =>
      fields(review, ['repository', 'branch', 'head', 'target', 'evidence'], 'Reviewed head'));
  }
  if (spec.httpsAuthorization !== undefined) {
    spec.httpsAuthorization = fields(spec.httpsAuthorization, ['endpoint', 'value'], 'HTTPS authorization');
  }
  const signal = data.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('ERR_INPUT', 'Supply an AbortSignal.');
  if (signal?.aborted) fail('ERR_ABORTED', 'Retirement was cancelled.');
  const backupOptions = { timeoutMs: data.timeoutMs, maxBackupBytes: data.maxBackupBytes, signal };
  const directory = resolve(text(data.directory, 'Backup directory', 4096));
  return { spec, expectedPlanId: data.expectedPlanId, directory, signal, backupOptions };
}

function connection(ctx, state) {
  return { cwd: state.source.root, timeoutMs: ctx.spec.timeoutMs ?? 10000,
    maxOutputBytes: ctx.spec.maxOutputBytes ?? 4 * 1024 * 1024, signal: ctx.signal };
}

async function commonDirectory(ctx, state) {
  const run = gitReader(connection(ctx, state));
  const result = await run(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return realpath(result.stdout.trim());
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function exclusiveWrite(directory, name, data) {
  const encoded = JSON.stringify(data, null, 2) + '\n';
  if (Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES) fail('ERR_RETIREMENT_LIMIT', 'Retirement journal is too large.');
  const pending = join(directory, '.retirement-' + randomUUID());
  const handle = await open(pending, 'wx', 0o600);
  try {
    try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
    await link(pending, join(directory, name));
  } finally { await unlink(pending); }
  await syncDirectory(directory);
  await syncDirectory(dirname(directory));
}

async function withLock(ctx, action) {
  const initial = await current(ctx);
  ctx.spec.cwd = initial.state.source.root;
  const common = await commonDirectory(ctx, initial.state);
  const path = join(common, 'ehven-retirement.lock');
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail('ERR_RETIREMENT_LOCK', 'This repository already has a retirement lock. Resolve the prior operation before retrying.');
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, directory: ctx.directory, createdAt: new Date().toISOString() }) + '\n');
    await lock.sync();
    const locked = await current(ctx);
    if (await commonDirectory(ctx, locked.state) !== common) fail('ERR_RETIREMENT_CHANGED', 'The Git directory changed during lock acquisition.');
    return await action(locked);
  } finally {
    try { await lock.close(); } finally { await unlink(path); }
  }
}

function current(ctx, live = false) {
  return inspectRetirementState({ ...ctx.spec, signal: ctx.signal }, { execution: true, live });
}

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function finalRefs(state) {
  const retiredLocal = new Set(state.plan.local.map(entry => entry.branch));
  const retiredRemote = new Set(state.plan.remote.map(entry => entry.branch));
  const local = new Map(state.refs.local.filter(([name]) => !retiredLocal.has(name)));
  for (const name of state.plan.align) local.set(name, state.plan.target);
  return {
    local: [...local].sort(),
    tracking: state.refs.tracking.filter(([name]) => !retiredRemote.has(name)),
  };
}

function writeDestination(data) {
  const destinations = approvedDestinations(data.state.raw, data.approved, data.authorization);
  if (destinations[0].url !== destinations[1].url) {
    fail('ERR_RETIREMENT_DESTINATION', 'Apply and recovery require the same effective fetch and push endpoint.');
  }
  return destinations[1];
}

function stateIdentity(state) {
  return { source: state.source, transport: state.transport, raw: state.raw, permanent: state.permanent };
}

function localPhase(observed, expected, after) {
  if (!same(stateIdentity(observed), stateIdentity(expected))) {
    fail('ERR_RETIREMENT_CHANGED', 'The source, endpoint or permanent-branch policy changed since approval.');
  }
  if (retirementPlanId(observed) === retirementPlanId(expected)) return 'before';
  if (same(observed.refs, after)) return 'after';
  fail('ERR_RETIREMENT_CHANGED', 'Local refs or reviewed work differ from both approved retirement states.');
}

function confirmPlan(state, id) {
  if (retirementPlanId(state) !== id) fail('ERR_RETIREMENT_PLAN', 'The current plan differs from the approved live preview.');
}

async function remotePhase(ctx, data, destination, original, after) {
  const heads = await queryHeads(destination, original.source.objectFormat, data.authorization, connection(ctx, original));
  const actual = [...heads].sort();
  if (same(actual, after.tracking)) return 'after';
  if (same(actual, original.refs.tracking)) return 'before';
  fail('ERR_RETIREMENT_CHANGED', 'Live refs differ from both approved retirement states. Preserve the backup and inspect the journal.');
}

async function isolatedPush(ctx, data, destination, state) {
  const directory = await mkdtemp(join(tmpdir(), 'ehven-retirement-push-'));
  try {
    const options = { ...connection(ctx, state), cwd: directory };
    const initialized = await runBounded('git', [...GIT_LOCAL_ARGS, 'init', '--bare', '--quiet', '--template=',
      `--object-format=${state.source.objectFormat}`, '--', directory], { ...options, isolatedConfig: true });
    if (initialized.status !== 0) fail('ERR_RETIREMENT_PUSH', 'Could not prepare an isolated push repository.');
    await pushRetirements(destination, state.plan.remote, data.authorization, options, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function transactLocal(ctx, state, after) {
  const changes = ['start'];
  const zero = '0'.repeat(state.source.head.length);
  for (const [scope, prefix] of [['local', 'refs/heads/'], ['tracking', `refs/remotes/${state.source.remote}/`]]) {
    const before = new Map(state.refs[scope]), desired = new Map(after[scope]);
    for (const name of new Set([...before.keys(), ...desired.keys()])) {
      const ref = prefix + name, prior = before.get(name), next = desired.get(name);
      changes.push('option no-deref');
      if (prior === next) changes.push(`verify ${ref} ${prior}`);
      else if (!next) changes.push(`delete ${ref} ${prior}`);
      else changes.push(`update ${ref} ${next} ${prior ?? zero}`);
    }
  }
  changes.push('prepare', '');
  let result;
  try {
    result = await runBounded('git', [...GIT_LOCAL_ARGS, 'update-ref', '--stdin'], {
      ...connection(ctx, state),
      input: changes.join('\n'),
      beforeCommit: async () => confirmPlan((await current(ctx)).state, ctx.expectedPlanId),
    });
  } catch (error) {
    if (error.code !== 'ERR_GIT_INPUT') throw error;
  }
  if (result?.status !== 0 || result.stdout !== 'start: ok\nprepare: ok\ncommit: ok\n') {
    fail('ERR_RETIREMENT_LOCAL', 'The local ref transaction failed or its result is uncertain. Review the journal before retrying.');
  }
}

async function readJournal(directory, expectedPlanId) {
  const path = await realpath(directory);
  if (!(await lstat(directory)).isDirectory()) fail('ERR_RETIREMENT_JOURNAL', 'The journal must be in the original backup directory.');
  const handle = await open(join(path, JOURNAL), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_JOURNAL_BYTES) fail('ERR_RETIREMENT_JOURNAL', 'The journal must be a bounded regular file.');
    bytes = Buffer.alloc(MAX_JOURNAL_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size || offset > MAX_JOURNAL_BYTES) fail('ERR_RETIREMENT_JOURNAL', 'The journal changed while it was read.');
    bytes = bytes.subarray(0, offset);
  } finally { await handle.close(); }
  try {
    const document = unambiguousJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (document.schemaVersion !== 1 || document.planId !== expectedPlanId || !ID.test(document.backupSha256)
        || retirementPlanId(document.state) !== expectedPlanId) throw new Error();
    return { ...document, directory: path };
  } catch {
    fail('ERR_RETIREMENT_JOURNAL', 'The journal does not match the approved plan ID.');
  }
}

async function complete(ctx, state, directory, initial, recovery) {
  const after = finalRefs(state);
  const destination = writeDestination(initial);
  const phase = localPhase(initial.state, state, after);
  let server = await remotePhase(ctx, initial, destination, state, after);
  if (phase === 'after' && server === 'before') {
    fail('ERR_RETIREMENT_CHANGED', 'Local completion disagrees with live refs. Preserve the backup and inspect before retrying.');
  }
  if (!recovery && phase === 'before' && state.plan.remote.length && server !== 'before') {
    fail('ERR_RETIREMENT_CHANGED', 'Remote refs changed before the initial mutation. Use recovery only after inspection.');
  }
  if (server === 'before') {
    const checked = await current(ctx);
    confirmPlan(checked.state, ctx.expectedPlanId);
    await isolatedPush(ctx, checked, writeDestination(checked), state);
    server = await remotePhase(ctx, checked, destination, state, after);
    if (server !== 'after') fail('ERR_RETIREMENT_PUSH', 'Live verification did not confirm the remote deletion.');
  }
  const beforeLocal = await current(ctx);
  if (localPhase(beforeLocal.state, state, after) === 'before' && !same(state.refs, after)) {
    await transactLocal(ctx, state, after);
  }
  const final = await current(ctx);
  if (!same(stateIdentity(final.state), stateIdentity(state)) || !same(final.state.refs, after)
      || await remotePhase(ctx, final, writeDestination(final), state, after) !== 'after') {
    fail('ERR_RETIREMENT_CHANGED', 'Final live and local snapshots did not confirm completion. Preserve the journal.');
  }
  return { completed: true, recovered: recovery, planId: ctx.expectedPlanId,
    directory, remoteRetired: state.plan.remote.length, localRetired: state.plan.local.length,
    localAligned: state.plan.align.length };
}

async function guarded(action) {
  try { return await action(); } catch (error) {
    if (error.code?.startsWith('ERR_')) throw error;
    fail('ERR_RETIREMENT_IO', 'Retirement could not access its repository, lock, backup or journal. Preserve the backup directory and inspect before retrying.');
  }
}

/** Requires an explicit reviewed plan ID. All write intent is durable before the first mutation. */
export async function applyRetirement(input) {
  return guarded(async () => {
    const ctx = parameters(input);
    return withLock(ctx, async () => {
      const first = await current(ctx, true);
      confirmPlan(first.state, ctx.expectedPlanId);
      writeDestination(first);
      const plan = first.state.plan;
      if (plan.remote.length === 0 && plan.local.length === 0 && plan.align.length === 0) {
        return { completed: true, recovered: false, planId: ctx.expectedPlanId, directory: null,
          remoteRetired: 0, localRetired: 0, localAligned: 0 };
      }
      if (plan.remote.length > 64) fail('ERR_RETIREMENT_LIMIT', 'The plan exceeds the supported size of one atomic push.');
      const { httpsAuthorization, ...inspection } = ctx.spec;
      const backup = await createRetirementBackup({ directory: ctx.directory, inspection, ...ctx.backupOptions });
      const fresh = await current(ctx, true);
      confirmPlan(fresh.state, ctx.expectedPlanId);
      await assertBackupCoversRetirement(backup.directory, fresh.state, backup.bundleSha256, ctx.signal);
      await exclusiveWrite(backup.directory, JOURNAL, { schemaVersion: 1, createdAt: new Date().toISOString(),
        planId: ctx.expectedPlanId, backupSha256: backup.bundleSha256, state: fresh.state });
      return complete(ctx, fresh.state, backup.directory, fresh, false);
    });
  });
}

/** Reconcile the exact recorded before/after states. Recovery never rolls refs back. */
export async function recoverRetirement(input) {
  return guarded(async () => {
    const ctx = parameters(input);
    return withLock(ctx, async initial => {
      const journal = await readJournal(ctx.directory, ctx.expectedPlanId);
      writeDestination(initial);
      localPhase(initial.state, journal.state, finalRefs(journal.state));
      const verified = await verifyRetirementBackup({ directory: journal.directory, ...ctx.backupOptions });
      if (verified.bundleSha256 !== journal.backupSha256) fail('ERR_RETIREMENT_BACKUP', 'The backup digest differs from the journal.');
      await assertBackupCoversRetirement(journal.directory, journal.state, journal.backupSha256, ctx.signal);
      const fresh = await current(ctx);
      return complete(ctx, journal.state, journal.directory, fresh, true);
    });
  });
}
