import { open, mkdir, mkdtemp, realpath, lstat, rm, link, unlink, constants } from 'node:fs/promises';
import { resolve, dirname, basename, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fields, list, branch, text, objectFormat, objectId } from '../validation.mjs';
import { fail } from '../errors.mjs';
import { inspectRetirements } from './inspect.mjs';
import { gitReader } from './process.mjs';
import { writeBundle } from './bundle-process.mjs';
import { unambiguousJson } from './config.mjs';

const MAX_MANIFEST = 4 * 1024 * 1024;
const REF_FORMAT = '--format=%(refname)%00%(objectname)%00%(symref)';

function operation(input, extra = []) {
  const data = fields(input, ['directory', 'timeoutMs', 'maxBackupBytes', 'signal', ...extra], 'Backup options');
  if (process.platform === 'win32' || !(constants.O_NOFOLLOW > 0) || !(constants.O_NONBLOCK > 0)) fail('ERR_BACKUP_PLATFORM', 'Backup requires supported POSIX process and regular-file protections.');
  const timeoutMs = data.timeoutMs === undefined ? 30000 : data.timeoutMs;
  const maxBackupBytes = data.maxBackupBytes === undefined ? 256 * 1024 * 1024 : data.maxBackupBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isSafeInteger(maxBackupBytes) || maxBackupBytes < 1024 || maxBackupBytes > 1024 * 1024 * 1024
      || (data.signal !== undefined && !(data.signal instanceof AbortSignal))) fail('ERR_INPUT', 'Supply supported backup limits and an optional AbortSignal.');
  const directory = resolve(text(data.directory, 'Backup directory', 4096));
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = data.signal ? AbortSignal.any([deadline, data.signal]) : deadline;
  const options = { timeoutMs, maxBackupBytes, maxOutputBytes: 4 * 1024 * 1024, signal };
  check(options);
  return { data, directory, options };
}

function check({ signal }) {
  if (signal?.aborted) fail(signal.reason?.name === 'TimeoutError' ? 'ERR_GIT_TIMEOUT' : 'ERR_ABORTED', 'Backup operation was cancelled or exceeded its deadline.');
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}

async function newPath(path) {
  try { return join(await realpath(dirname(path)), basename(path)); }
  catch { fail('ERR_BACKUP_PATH', 'Use an available trusted parent directory.'); }
}

async function exclusiveDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); }
  catch { fail('ERR_BACKUP_DESTINATION', 'The destination must be a new directory in an available trusted parent.'); }
}

async function protectExistingRepositories(path) {
  async function exists(entry) {
    try { await lstat(entry); return true; }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
  }
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (await exists(join(parent, '.git')) || (
      await exists(join(parent, 'HEAD')) && await exists(join(parent, 'objects')) && await exists(join(parent, 'refs'))
    )) fail('ERR_BACKUP_DESTINATION', 'Recover outside existing Git working trees and metadata directories.');
    if (parent === dirname(parent)) break;
  }
}

async function existingDirectory(path) {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error();
    return await realpath(path);
  } catch { fail('ERR_BACKUP_PATH', 'Backup must be an available directory without a final symlink.'); }
}

async function regular(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) throw new Error();
    return handle;
  } catch {
    await handle?.close();
    fail('ERR_BACKUP_FILE', 'Backup input must be an available regular file without a final symlink.');
  }
}

const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

async function transfer(handle, options, maximum, target) {
  const before = await handle.stat({ bigint: true });
  if (!before.isFile()) fail('ERR_BACKUP_FILE', 'Backup input must remain a regular file.');
  if (before.size > BigInt(maximum)) fail('ERR_BACKUP_LIMIT', 'Backup input exceeds the supported byte limit.');
  const hash = createHash('sha256'), header = [];
  let bytes = 0, headerBytes = 0, ended = false, previous = -1;
  while (true) {
    check(options);
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (!bytesRead) break;
    bytes += bytesRead;
    if (bytes > maximum) fail('ERR_BACKUP_LIMIT', 'Backup input exceeds the supported byte limit.');
    const data = buffer.subarray(0, bytesRead); hash.update(data);
    if (!ended) {
      let index = 0;
      for (; index < data.length; index++) {
        const value = data[index];
        if (++headerBytes > MAX_MANIFEST) fail('ERR_BACKUP_LIMIT', 'Bundle header exceeds the supported limit.');
        if (value === 10 && previous === 10) { ended = true; index++; break; }
        previous = value;
      }
      header.push(data.subarray(0, index));
    }
    if (target) {
      let offset = 0;
      while (offset < data.length) {
        check(options);
        const { bytesWritten } = await target.write(data, offset, data.length - offset, null);
        if (!bytesWritten) fail('ERR_BACKUP_IO', 'Backup copy could not be written.');
        offset += bytesWritten;
      }
    }
  }
  const after = await handle.stat({ bigint: true });
  if (!unchanged(before, after) || after.size !== BigInt(bytes)) fail('ERR_BACKUP_CHANGED', 'Backup input changed while being read.');
  check(options);
  return { bytes, sha256: hash.digest('hex'), header: Buffer.concat(header), ended };
}

function fullRef(name) {
  branch(name, 'Full ref name');
  if (!name.startsWith('refs/')) fail('ERR_BACKUP_MANIFEST', 'Backup refs must use full refs/ names.');
  return name;
}

function refList(value, format) {
  const refs = list(value, 'Backup refs', 10000).map(item => {
    const ref = fields(item, ['name', 'oid', 'symbolicTarget'], 'Backup ref');
    const result = { name: fullRef(ref.name), oid: objectId(ref.oid, format) };
    if (ref.symbolicTarget !== undefined) result.symbolicTarget = fullRef(ref.symbolicTarget);
    return result;
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const map = new Map(refs.map(ref => [ref.name, ref]));
  if (!refs.length || map.size !== refs.length) fail('ERR_BACKUP_MANIFEST', 'Backup refs must be nonempty and distinct.');
  if (refs.filter(ref => ref.symbolicTarget).length > 100) fail('ERR_BACKUP_LIMIT', 'Too many symbolic refs for supported recovery.');
  for (const ref of refs) {
    let current = ref; const seen = new Set();
    while (current.symbolicTarget) {
      if (seen.has(current.name)) fail('ERR_BACKUP_MANIFEST', 'Symbolic backup refs must not form cycles.');
      seen.add(current.name); current = map.get(current.symbolicTarget);
      if (!current || current.oid !== ref.oid) fail('ERR_BACKUP_MANIFEST', 'Symbolic backup refs require matching recorded targets.');
    }
  }
  return refs;
}

function manifest(value) {
  const data = fields(value, ['schemaVersion', 'kind', 'createdAt', 'repository', 'source', 'bundle', 'refs'], 'Backup manifest');
  if (data.schemaVersion !== 1 || data.kind !== 'git-release-guardrails-backup'
      || typeof data.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(data.createdAt) || Number.isNaN(Date.parse(data.createdAt))) fail('ERR_BACKUP_MANIFEST', 'Use a supported backup manifest.');
  const source = fields(data.source, ['branch', 'head', 'objectFormat'], 'Backup source');
  if (!Object.hasOwn(source, 'objectFormat')) fail('ERR_BACKUP_MANIFEST', 'Backup source must declare its object format.');
  const format = objectFormat(source.objectFormat);
  const branchName = branch(source.branch), head = objectId(source.head, format);
  const bundle = fields(data.bundle, ['file', 'bytes', 'sha256'], 'Backup bundle');
  if (bundle.file !== 'repository.bundle' || !Number.isSafeInteger(bundle.bytes) || bundle.bytes < 1
      || bundle.bytes > 1024 * 1024 * 1024 || typeof bundle.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(bundle.sha256)) fail('ERR_BACKUP_MANIFEST', 'Backup bundle identity is invalid.');
  const refs = refList(data.refs, format), attached = refs.find(ref => ref.name === `refs/heads/${branchName}`);
  if (!attached || attached.symbolicTarget || attached.oid !== head) fail('ERR_BACKUP_MANIFEST', 'Backup HEAD must match its attached recorded branch.');
  return { schemaVersion: 1, kind: data.kind, createdAt: data.createdAt, repository: text(data.repository, 'Backup repository'),
    source: { branch: branchName, head, objectFormat: format }, bundle: { file: bundle.file, bytes: bundle.bytes, sha256: bundle.sha256 }, refs };
}

async function readManifest(directory, options) {
  const handle = await regular(join(directory, 'manifest.json'));
  try {
    const chunks = []; let bytes = 0;
    const before = await handle.stat({ bigint: true });
    if (before.size > BigInt(MAX_MANIFEST)) fail('ERR_BACKUP_LIMIT', 'Backup manifest exceeds the supported limit.');
    while (true) {
      check(options); const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > MAX_MANIFEST) fail('ERR_BACKUP_LIMIT', 'Backup manifest exceeds the supported limit.');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (!unchanged(before, await handle.stat({ bigint: true })) || before.size !== BigInt(bytes)) fail('ERR_BACKUP_CHANGED', 'Backup manifest changed while being read.');
    let value;
    try { value = unambiguousJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))); }
    catch { fail('ERR_BACKUP_MANIFEST', 'Backup manifest must be unambiguous UTF-8 JSON.'); }
    return manifest(value);
  } finally { await handle.close(); }
}

function validateHeader(input, data) {
  const string = input.header.toString('utf8');
  if (!input.ended || !Buffer.from(string).equals(input.header)) fail('ERR_BACKUP_BUNDLE', 'Bundle header is incomplete or not UTF-8.');
  const lines = string.slice(0, -2).split('\n'), signature = lines.shift();
  let format = 'sha1';
  if (signature === '# v3 git bundle') {
    if (!['@object-format=sha1', '@object-format=sha256'].includes(lines[0])) fail('ERR_BACKUP_BUNDLE', 'Bundle object format is unsupported.');
    format = lines.shift().slice('@object-format='.length);
  } else if (signature !== '# v2 git bundle') fail('ERR_BACKUP_BUNDLE', 'Bundle version is unsupported.');
  if (format !== data.source.objectFormat) fail('ERR_BACKUP_BUNDLE', 'Bundle object format conflicts with the manifest.');
  const heads = new Map(data.refs.map(ref => [ref.name, ref.oid])); heads.set('HEAD', data.source.head);
  for (const line of lines) {
    const index = line.indexOf(' '), oid = line.slice(0, index), name = line.slice(index + 1);
    // Reject prerequisites, filtered/unknown capabilities and extra/duplicate refs.
    if (index < 1 || !heads.has(name) || heads.get(name) !== oid) fail('ERR_BACKUP_BUNDLE', 'Require an exact self-contained bundle without prerequisites or extra capabilities.');
    heads.delete(name);
  }
  if (heads.size) fail('ERR_BACKUP_BUNDLE', 'Bundle does not advertise every recorded ref and HEAD.');
}

async function snapshot(run, format) {
  // Ref listings can omit dangling symbolic refs without a diagnostic.
  const connectivity = await run(['fsck', '--connectivity-only', '--no-reflogs', '--no-dangling']).catch(error => {
    if (error.code !== 'ERR_GIT_COMMAND') throw error;
    fail('ERR_BACKUP_REFS', 'Git reported broken refs or incomplete reachable history.');
  });
  if (connectivity.stderrBytes) fail('ERR_BACKUP_REFS', 'Git reported uncertain reachable history.');
  const result = await run(['for-each-ref', REF_FORMAT]);
  if (result.stderrBytes) fail('ERR_BACKUP_REFS', 'Git reported uncertain ref metadata.');
  const refs = [];
  let aliases = 0;
  for (const line of result.stdout.replace(/\n$/u, '').split('\n').filter(Boolean)) {
    const parts = line.split('\0');
    if (parts.length !== 3) fail('ERR_GIT_PARSE', 'Git returned malformed backup refs.');
    const [name, oid, symbolic] = parts;
    const ref = { name: fullRef(name), oid };
    if (symbolic) {
      if (++aliases > 100) fail('ERR_BACKUP_LIMIT', 'Too many symbolic refs for supported recovery.');
      ref.symbolicTarget = (await run(['symbolic-ref', '--no-recurse', name])).stdout.trim();
    }
    refs.push(ref);
  }
  return { refs: refList(refs, format), attached: (await run(['symbolic-ref', '--quiet', '--no-recurse', 'HEAD'])).stdout.trim(),
    head: objectId((await run(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim(), format) };
}

function summary(data, directory) {
  return { verified: true, repository: data.repository, objectFormat: data.source.objectFormat, refCount: data.refs.length,
    bundleSha256: data.bundle.sha256, bundleBytes: data.bundle.bytes, directory, networkAccess: false, sourceRefMutations: false };
}

async function restoreData(directory, data, options, destination) {
  const temporary = await mkdtemp(join(tmpdir(), 'git-guardrails-restore-'));
  try {
    // Clone only the privately staged exact bytes that were hashed, not a path
    // that could be exchanged between verification and Git opening it.
    const staged = join(temporary, 'repository.bundle'), input = await regular(join(directory, 'repository.bundle'));
    let output;
    try {
      output = await open(staged, 'wx', 0o600);
      const copied = await transfer(input, options, options.maxBackupBytes, output);
      if (copied.bytes !== data.bundle.bytes || copied.sha256 !== data.bundle.sha256) fail('ERR_BACKUP_INTEGRITY', 'Backup bundle size or digest does not match the manifest.');
      validateHeader(copied, data); await output.sync();
    } finally { await input.close(); await output?.close(); }
    check(options);
    const target = destination ?? join(temporary, 'proof.git');
    await exclusiveDirectory(target);
    const run = gitReader({ ...options, cwd: temporary, isolatedConfig: true });
    await run(['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--mirror', '--no-hardlinks', '--template=', '--', staged, target]);
    const recovered = gitReader({ ...options, cwd: target, isolatedConfig: true });
    // Remove clone transport configuration without deleting any recovered refs.
    await recovered(['config', '--local', '--remove-section', 'remote.origin']);
    for (const ref of data.refs) if (ref.symbolicTarget) await recovered(['symbolic-ref', ref.name, ref.symbolicTarget]);
    await recovered(['symbolic-ref', 'HEAD', `refs/heads/${data.source.branch}`]);
    const format = (await recovered(['rev-parse', '--show-object-format'])).stdout.trim();
    const actual = await snapshot(recovered, data.source.objectFormat);
    if (format !== data.source.objectFormat || actual.attached !== `refs/heads/${data.source.branch}`
        || actual.head !== data.source.head || JSON.stringify(actual.refs) !== JSON.stringify(data.refs)) fail('ERR_BACKUP_RESTORE', 'Recovered refs or object format do not match the backup.');
    await recovered(['fsck', '--full', '--strict']);
    if ((await recovered(['rev-parse', '--is-bare-repository'])).stdout.trim() !== 'true'
        || (await recovered(['rev-parse', '--is-shallow-repository'])).stdout.trim() !== 'false') fail('ERR_BACKUP_RESTORE', 'Require a full bare recovery repository.');
    check(options);
    return { ...summary(data, directory), ...(destination ? { destination: target } : {}) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function guarded(action) {
  try { return await action(); }
  catch (error) {
    if (error.code?.startsWith('ERR_')) throw error;
    fail('ERR_BACKUP_IO', 'Backup operation failed; preserve any partial new directory for inspection.');
  }
}

/** Backup inspected, committed/ref-reachable Git history; never original refs/config/files. */
export async function createRetirementBackup(input) {
  return guarded(async () => {
    const { data, directory: requested, options } = operation(input, ['inspection']);
    const source = fields(data.inspection, ['cwd', 'repository', 'expectedRemoteUrls', 'remote', 'integrationBranch', 'permanent',
      'reviewedHeads', 'temporaryPrefixes', 'timeoutMs', 'maxOutputBytes'], 'Backup inspection');
    for (const name of ['permanent', 'expectedRemoteUrls', 'temporaryPrefixes']) if (source[name] !== undefined) source[name] = list(source[name], name, 10000);
    if (source.reviewedHeads !== undefined) source.reviewedHeads = list(source.reviewedHeads, 'Reviewed heads', 10000)
      .map(item => fields(item, ['repository', 'branch', 'head', 'target', 'evidence'], 'Reviewed head'));
    const inspection = await inspectRetirements({ ...source, signal: options.signal });
    source.cwd = inspection.source.root;
    const run = gitReader({ ...options, cwd: inspection.source.root });
    const common = await realpath(resolve(inspection.source.root, (await run(['rev-parse', '--git-common-dir'])).stdout.trim()));
    const directory = await newPath(requested);
    if (inside(directory, inspection.source.root) || inside(directory, common)) fail('ERR_BACKUP_DESTINATION', 'Store backup outside the source working tree and Git directory.');
    const before = await snapshot(run, inspection.source.objectFormat);
    if (before.attached !== `refs/heads/${inspection.source.branch}` || before.head !== inspection.source.head) fail('ERR_BACKUP_CHANGED', 'Source changed before backup.');
    check(options); await exclusiveDirectory(directory);
    const handle = await open(join(directory, 'repository.bundle'), 'wx', 0o600);
    try { await writeBundle(handle, { ...options, cwd: inspection.source.root }); }
    finally { await handle.close(); }
    const reader = await regular(join(directory, 'repository.bundle'));
    let identity;
    try { identity = await transfer(reader, options, options.maxBackupBytes); }
    finally { await reader.close(); }
    const value = manifest({ schemaVersion: 1, kind: 'git-release-guardrails-backup', createdAt: new Date().toISOString(),
      repository: inspection.plan.repository, source: { branch: inspection.source.branch, head: inspection.source.head, objectFormat: inspection.source.objectFormat },
      bundle: { file: 'repository.bundle', bytes: identity.bytes, sha256: identity.sha256 }, refs: before.refs });
    validateHeader(identity, value);
    await restoreData(directory, value, options);
    const reinspection = await inspectRetirements({ ...source, signal: options.signal });
    const after = await snapshot(run, inspection.source.objectFormat);
    if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(inspection) !== JSON.stringify(reinspection)) fail('ERR_BACKUP_CHANGED', 'Source changed during backup; no completed manifest was written.');
    check(options);
    const encoded = JSON.stringify(value, null, 2) + '\n';
    if (Buffer.byteLength(encoded) > MAX_MANIFEST) fail('ERR_BACKUP_LIMIT', 'Backup manifest exceeds the supported limit.');
    const pending = join(directory, '.manifest.pending');
    const completed = await open(pending, 'wx', 0o600);
    try { await completed.writeFile(encoded); await completed.sync(); }
    finally { await completed.close(); }
    check(options);
    // Publish only the complete fsynced manifest, without replacing any path.
    await link(pending, join(directory, 'manifest.json')); await unlink(pending);
    const folder = await open(directory, constants.O_RDONLY);
    try { await folder.sync(); } finally { await folder.close(); }
    check(options);
    return summary(value, directory);
  });
}

/** Hash/header checks plus an actual isolated restoration and full Git fsck. */
export async function verifyRetirementBackup(input) {
  return guarded(async () => {
    const { directory: requested, options } = operation(input);
    const directory = await existingDirectory(requested), data = await readManifest(directory, options);
    return restoreData(directory, data, options);
  });
}

// Internal binding between the approved heads and the verified Git bundle.
export async function assertBackupCoversRetirement(directory, state, checksum, signal) {
  const options = { signal };
  const data = await readManifest(await existingDirectory(directory), options);
  const byName = new Map(data.refs.map(ref => [ref.name, ref]));
  const source = state.source;
  const expected = [
    ...state.refs.local.map(([name, id]) => [`refs/heads/${name}`, id]),
    ...state.refs.tracking.map(([name, id]) => [`refs/remotes/${source.remote}/${name}`, id]),
  ];
  if (data.repository !== state.plan.repository || data.source.branch !== source.branch ||
      data.source.head !== source.head || data.source.objectFormat !== source.objectFormat || data.bundle.sha256 !== checksum ||
      expected.some(([name, id]) => byName.get(name)?.oid !== id || byName.get(name)?.symbolicTarget)) {
    fail('ERR_RETIREMENT_BACKUP', 'The verified backup does not cover the approved direct branch refs.');
  }
}

/** Restore only into a newly created bare repository, never an existing live repo. */
export async function restoreRetirementBackup(input) {
  return guarded(async () => {
    const { data: request, directory: requested, options } = operation(input, ['destination']);
    const destination = await newPath(resolve(text(request.destination, 'Recovery destination', 4096)));
    const directory = await existingDirectory(requested), data = await readManifest(directory, options);
    if (inside(destination, directory)) fail('ERR_BACKUP_DESTINATION', 'Recover outside the backup directory.');
    await protectExistingRepositories(destination);
    return restoreData(directory, data, options, destination);
  });
}
