import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, statSync, symlinkSync, chmodSync, realpathSync, readdirSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createRetirementBackup, verifyRetirementBackup, restoreRetirementBackup } from '../src/node/index.mjs';
import { inspectionFixture } from './helpers/inspection-fixture.mjs';

function paths(f) { return { directory: join(f.directory, 'private backup'), destination: join(f.directory, 'recovered.git') }; }
function runIn(f, destination, ...args) {
  return execFileSync('git', args, { cwd: destination, env: f.env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function rewriteManifest(directory, mutate) {
  const file = join(directory, 'manifest.json'), data = JSON.parse(readFileSync(file)); mutate(data);
  writeFileSync(file, JSON.stringify(data));
}

for (const format of ['sha1', 'sha256']) test(`self-contained ${format} backup restores every ref, tag and symbolic alias after source removal`, async t => {
  const f = inspectionFixture(t, format), { directory, destination } = paths(f);
  f.git('tag', '-a', 'v1-fixture', '-m', 'Annotated fixture');
  f.git('update-ref', 'refs/notes/fixture', f.base);
  f.git('symbolic-ref', 'refs/meta/current', 'refs/heads/main');
  f.git('symbolic-ref', 'refs/meta/alias', 'refs/meta/current');
  const refs = f.git('for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)');
  const config = readFileSync(join(f.root, '.git', 'config')), before = f.git('show-ref');
  const result = await createRetirementBackup({ directory, inspection: f.options });
  assert.equal(result.verified, true); assert.equal(result.objectFormat, format);
  assert.equal(result.sourceRefMutations, false); assert.equal(result.networkAccess, false);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(directory).sort(), ['manifest.json', 'repository.bundle']);
  for (const name of ['manifest.json', 'repository.bundle']) assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
  assert.equal(f.git('show-ref'), before); assert.deepEqual(readFileSync(join(f.root, '.git', 'config')), config);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(JSON.parse(readFileSync(join(directory, 'manifest.json'))).bundle.sha256, result.bundleSha256);
  rmSync(f.root, { recursive: true });
  const global = join(f.directory, 'hostile-global'); writeFileSync(global, 'invalid Git configuration!!!');
  process.env.GIT_CONFIG_GLOBAL = global;
  assert.deepEqual(await verifyRetirementBackup({ directory }), result);
  assert.deepEqual(await restoreRetirementBackup({ directory, destination }), { ...result, destination });
  assert.equal(runIn(f, destination, 'for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)'), refs);
  assert.equal(runIn(f, destination, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.equal(runIn(f, destination, 'symbolic-ref', '--no-recurse', 'refs/meta/alias'), 'refs/meta/current');
  assert.equal(runIn(f, destination, 'rev-parse', '--is-bare-repository'), 'true');
  assert.equal(runIn(f, destination, 'rev-parse', '--is-shallow-repository'), 'false');
  assert.equal(runIn(f, destination, 'fsck', '--full', '--strict'), '');
  const network = spawnSync('git', ['config', '--local', '--get-regexp', '^remote\\.'], { cwd: destination, env: f.env });
  assert.equal(network.status, 1, 'no clone transport configuration is restored');
});

test('concurrent callers cannot overwrite the same backup or recovery destination', async t => {
  const f = inspectionFixture(t), { directory, destination } = paths(f);
  const backups = await Promise.allSettled([createRetirementBackup({ directory, inspection: f.options }), createRetirementBackup({ directory, inspection: f.options })]);
  assert.equal(backups.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(backups.find(result => result.status === 'rejected').reason.code, 'ERR_BACKUP_DESTINATION');
  const restores = await Promise.allSettled([restoreRetirementBackup({ directory, destination }), restoreRetirementBackup({ directory, destination })]);
  assert.equal(restores.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(restores.find(result => result.status === 'rejected').reason.code, 'ERR_BACKUP_DESTINATION');
  assert.equal((await verifyRetirementBackup({ directory })).verified, true);
});

test('refuses backup inside source/Git metadata and refuses overwriting existing paths', async t => {
  const f = inspectionFixture(t), { directory, destination } = paths(f);
  for (const path of [join(f.root, 'backup'), join(f.root, '.git', 'backup')]) {
    await assert.rejects(createRetirementBackup({ inspection: f.options, directory: path }), { code: 'ERR_BACKUP_DESTINATION' });
    assert.equal(existsSync(path), false);
  }
  mkdirSync(directory); writeFileSync(join(directory, 'keep'), 'keep');
  await assert.rejects(createRetirementBackup({ inspection: f.options, directory }), { code: 'ERR_BACKUP_DESTINATION' });
  assert.equal(readFileSync(join(directory, 'keep'), 'utf8'), 'keep');
  rmSync(directory, { recursive: true });
  await createRetirementBackup({ inspection: f.options, directory });
  for (const type of ['directory', 'file', 'symlink']) {
    if (type === 'directory') mkdirSync(destination);
    if (type === 'file') writeFileSync(destination, 'keep');
    if (type === 'symlink') symlinkSync(directory, destination);
    await assert.rejects(restoreRetirementBackup({ directory, destination }), { code: 'ERR_BACKUP_DESTINATION' });
    if (type === 'file') assert.equal(readFileSync(destination, 'utf8'), 'keep');
    rmSync(destination, { recursive: true });
  }
  for (const parent of [directory, f.root, join(f.root, '.git', 'refs')]) {
    const nested = join(parent, 'nested');
    await assert.rejects(restoreRetirementBackup({ directory, destination: nested }), { code: 'ERR_BACKUP_DESTINATION' });
    assert.equal(existsSync(nested), false);
  }
});

test('uncertain separate-Git-dir worktree metadata is refused before writing backup', async t => {
  const f = inspectionFixture(t), metadata = join(f.directory, 'git metadata');
  f.git('init', '--quiet', '--separate-git-dir', metadata);
  f.git('config', 'core.worktree', f.root);
  const directory = join(metadata, 'backup');
  await assert.rejects(createRetirementBackup({ inspection: f.options, directory }), { code: 'ERR_WORKTREE' });
  assert.equal(existsSync(directory), false);
});

test('corruption/truncation is refused before creating a recovery destination', async t => {
  const f = inspectionFixture(t), { directory, destination } = paths(f);
  await createRetirementBackup({ inspection: f.options, directory });
  const path = join(directory, 'repository.bundle'), bytes = readFileSync(path);
  for (const replacement of [bytes.subarray(0, -1), Buffer.concat([bytes, Buffer.from('extra')]), Buffer.from(bytes)]) {
    if (replacement.length === bytes.length) replacement[replacement.length - 1] ^= 1;
    writeFileSync(path, replacement);
    await assert.rejects(verifyRetirementBackup({ directory }), { code: 'ERR_BACKUP_INTEGRITY' });
    await assert.rejects(restoreRetirementBackup({ directory, destination }), { code: 'ERR_BACKUP_INTEGRITY' });
    assert.equal(existsSync(destination), false);
  }
});

test('refuses prerequisites, unknown capabilities, missing refs and invalid packs even with a matching digest', async t => {
  const f = inspectionFixture(t), { directory, destination } = paths(f);
  await createRetirementBackup({ inspection: f.options, directory });
  const path = join(directory, 'repository.bundle'), original = readFileSync(path), originalManifest = readFileSync(join(directory, 'manifest.json'));
  const end = original.indexOf('\n\n'), header = original.subarray(0, end).toString('utf8'), pack = original.subarray(end + 2);
  const cases = [
    [header.replace('\n', `\n-${f.base} prerequisite\n`), pack, 'ERR_BACKUP_BUNDLE'],
    [header.replace('\n', '\n@filter=blob:none\n'), pack, 'ERR_BACKUP_BUNDLE'],
    [header.split('\n').slice(0, -1).join('\n'), pack, 'ERR_BACKUP_BUNDLE'],
    [header, Buffer.from('PACK-invalid'), 'ERR_GIT_COMMAND'],
  ];
  for (const [changedHeader, changedPack, code] of cases) {
    writeFileSync(join(directory, 'manifest.json'), originalManifest);
    const bytes = Buffer.concat([Buffer.from(changedHeader + '\n\n'), changedPack]); writeFileSync(path, bytes);
    rewriteManifest(directory, data => { data.bundle.sha256 = digest(bytes); data.bundle.bytes = bytes.length; });
    await assert.rejects(restoreRetirementBackup({ directory, destination }), { code });
    rmSync(destination, { recursive: true, force: true });
  }
});

test('rejects malformed/duplicate manifest input, conflicting HEAD, aliases and bundle paths', async t => {
  const f = inspectionFixture(t), { directory } = paths(f);
  await createRetirementBackup({ inspection: f.options, directory });
  const file = join(directory, 'manifest.json'), original = readFileSync(file);
  for (const change of [d => { d.schemaVersion = 2; }, d => { d.bundle.file = '../outside'; },
    d => { d.source.head = f.base; }, d => { delete d.source.objectFormat; }, d => { d.refs.push(d.refs[0]); },
    d => { d.refs[0].name = 'refs/heads/../unsafe'; }, d => { d.refs[0].symbolicTarget = 'refs/heads/missing'; },
    d => { d.refs[0].symbolicTarget = d.refs[0].name; }, d => { d.execute = 'forbidden'; }]) {
    writeFileSync(file, original); rewriteManifest(directory, change);
    await assert.rejects(verifyRetirementBackup({ directory }), error => error.code.startsWith('ERR_'));
  }
  for (const data of [Buffer.from([255]), '{"schemaVersion":1,"schemaVersion":1}', ' '.repeat(4 * 1024 * 1024 + 1)]) {
    writeFileSync(file, data);
    await assert.rejects(verifyRetirementBackup({ directory }), error => ['ERR_BACKUP_MANIFEST', 'ERR_BACKUP_LIMIT'].includes(error.code));
  }
});

test('refuses missing manifest, final symlinks, directories and FIFOs without consuming them', { timeout: 10000 }, async t => {
  const f = inspectionFixture(t), { directory } = paths(f);
  await createRetirementBackup({ inspection: f.options, directory });
  const alias = join(f.directory, 'backup-alias'); symlinkSync(directory, alias);
  await assert.rejects(verifyRetirementBackup({ directory: alias }), { code: 'ERR_BACKUP_PATH' });
  for (const name of ['manifest.json', 'repository.bundle']) {
    const path = join(directory, name), bytes = readFileSync(path), safe = join(f.directory, name + '.safe'); writeFileSync(safe, bytes);
    for (const type of ['missing', 'link', 'folder', 'fifo']) {
      rmSync(path, { recursive: true, force: true });
      if (type === 'link') symlinkSync(safe, path);
      if (type === 'folder') mkdirSync(path);
      if (type === 'fifo') assert.equal(spawnSync('mkfifo', [path]).status, 0);
      await assert.rejects(verifyRetirementBackup({ directory }), { code: 'ERR_BACKUP_FILE' });
    }
    rmSync(path); writeFileSync(path, bytes);
  }
});

test('enforces limits, cancellation and no completed manifest after an oversized bundle', async t => {
  const f = inspectionFixture(t), { directory } = paths(f);
  writeFileSync(join(f.root, 'random.bin'), randomBytes(16384)); f.git('add', '.'); f.git('commit', '-m', 'Larger fixture');
  const head = f.git('rev-parse', 'HEAD');
  f.git('update-ref', 'refs/remotes/origin/main', head); f.git('update-ref', 'refs/remotes/origin/live', head);
  const inspection = { ...f.options, reviewedHeads: [{ ...f.options.reviewedHeads[0], target: head }] };
  await assert.rejects(createRetirementBackup({ directory, inspection, maxBackupBytes: 1024 }), { code: 'ERR_BACKUP_LIMIT' });
  assert.equal(existsSync(join(directory, 'manifest.json')), false);
  assert.ok(statSync(join(directory, 'repository.bundle')).size <= 1024);
  await assert.rejects(createRetirementBackup({ directory: join(f.directory, 'cancelled'), inspection, signal: AbortSignal.abort() }), { code: 'ERR_ABORTED' });
  for (const change of [{ maxBackupBytes: null }, { maxBackupBytes: 1 }, { timeoutMs: null }, { timeoutMs: 30001 }, { signal: {} }]) {
    await assert.rejects(verifyRetirementBackup({ directory, ...change }), { code: 'ERR_INPUT' });
  }
  await assert.rejects(createRetirementBackup({ directory: join(f.directory, 'deadline'), inspection, timeoutMs: 1 }), { code: 'ERR_GIT_TIMEOUT' });
});

function interceptGit(f, body) {
  const bin = join(f.directory, 'wrapper-bin'); mkdirSync(bin);
  const oldPath = process.env.PATH;
  const realGit = realpathSync(oldPath.split(delimiter).map(dir => join(dir, 'git')).find(existsSync));
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!${process.execPath}\n` + `
    const {spawnSync,execFileSync}=require('node:child_process');
    const {writeFileSync,existsSync}=require('node:fs');
    const realGit=${JSON.stringify(realGit)}, root=${JSON.stringify(f.root)}, args=process.argv.slice(2);
    ${body}
    const result=spawnSync(realGit,args,{env:process.env,stdio:'inherit'});process.exit(result.status??1);
  `); chmodSync(wrapper, 0o700); process.env.PATH = bin + delimiter + oldPath;
  return () => { process.env.PATH = oldPath; };
}

test('a source ref change during backup proof prevents writing the completion manifest', async t => {
  const f = inspectionFixture(t), { directory } = paths(f), flag = join(f.directory, 'changed');
  const reset = interceptGit(f, `if(args.includes('clone')&&!existsSync(${JSON.stringify(flag)})) {
    writeFileSync(${JSON.stringify(flag)},'changed');
    execFileSync(realGit,['-C',root,'update-ref','refs/tags/concurrent',${JSON.stringify(f.target)}]);
  }`);
  try { await assert.rejects(createRetirementBackup({ directory, inspection: f.options }), { code: 'ERR_BACKUP_CHANGED' }); }
  finally { reset(); }
  assert.equal(existsSync(join(directory, 'manifest.json')), false);
  assert.equal(f.git('rev-parse', 'refs/tags/concurrent'), f.target);
});

test('cancels an active bundle subprocess without a completed manifest or source changes', { timeout: 10000 }, async t => {
  const f = inspectionFixture(t), { directory } = paths(f), ready = join(f.directory, 'bundle-ready'), before = f.git('show-ref');
  const reset = interceptGit(f, `if(args.includes('bundle')&&args.includes('create')) {
    writeFileSync(${JSON.stringify(ready)},'ready');
    setTimeout(()=>{},5000);return;
  }`);
  const controller = new AbortController();
  const operation = createRetirementBackup({ directory, inspection: f.options, signal: controller.signal });
  const rejected = assert.rejects(operation, { code: 'ERR_ABORTED' });
  try {
    const deadline = performance.now() + 4000;
    while (!existsSync(ready) && performance.now() < deadline) await delay(10);
    assert.ok(existsSync(ready)); controller.abort(); await rejected;
  } finally { controller.abort(); reset(); }
  assert.equal(existsSync(join(directory, 'manifest.json')), false);
  assert.equal(f.git('show-ref'), before);
});

test('changed refs advertised during bundle creation cannot pass the recorded snapshot', async t => {
  const f = inspectionFixture(t), { directory } = paths(f);
  const reset = interceptGit(f, `if(args.includes('bundle')&&args.includes('create')) {
    execFileSync(realGit,['-C',root,'update-ref','refs/tags/new-during-pack',${JSON.stringify(f.target)}]);
  }`);
  try { await assert.rejects(createRetirementBackup({ directory, inspection: f.options }), { code: 'ERR_BACKUP_BUNDLE' }); }
  finally { reset(); }
  assert.equal(existsSync(join(directory, 'manifest.json')), false);
  assert.equal(f.git('rev-parse', 'refs/tags/new-during-pack'), f.target);
});

test('interrupted restoration preserves the original backup and leaves its new partial destination for review', { timeout: 10000 }, async t => {
  const f = inspectionFixture(t), { directory, destination } = paths(f), ready = join(f.directory, 'restore-ready');
  await createRetirementBackup({ directory, inspection: f.options });
  const manifest = readFileSync(join(directory, 'manifest.json')), bundle = digest(readFileSync(join(directory, 'repository.bundle'))), refs = f.git('show-ref');
  const reset = interceptGit(f, `if(args.includes('fsck')&&args.includes('--full')) {
    writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},5000);return;
  }`);
  const controller = new AbortController();
  const operation = restoreRetirementBackup({ directory, destination, signal: controller.signal });
  const rejected = assert.rejects(operation, { code: 'ERR_ABORTED' });
  try {
    const deadline = performance.now() + 4000;
    while (!existsSync(ready) && performance.now() < deadline) await delay(10);
    assert.ok(existsSync(ready)); controller.abort(); await rejected;
  } finally { controller.abort(); reset(); }
  assert.equal(existsSync(destination), true);
  assert.equal(f.git('show-ref'), refs);
  assert.deepEqual(readFileSync(join(directory, 'manifest.json')), manifest);
  assert.equal(digest(readFileSync(join(directory, 'repository.bundle'))), bundle);
  await assert.rejects(restoreRetirementBackup({ directory, destination }), { code: 'ERR_BACKUP_DESTINATION' });
  assert.equal((await verifyRetirementBackup({ directory })).verified, true);
});


test('a dangling symbolic ref blocks backup instead of disappearing from the inventory', async t => {
  const f = inspectionFixture(t), { directory } = paths(f);
  f.git('symbolic-ref', 'refs/meta/broken', 'refs/heads/missing');
  await assert.rejects(createRetirementBackup({ directory, inspection: f.options }), { code: 'ERR_BACKUP_REFS' });
  assert.equal(existsSync(directory), false);
});
