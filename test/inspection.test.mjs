import test from 'node:test';
import assert from 'node:assert/strict';
import { join, delimiter } from 'node:path';
import { readFileSync, writeFileSync, statSync, utimesSync, rmSync, mkdirSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { inspectRetirements } from '../src/node/index.mjs';
import { inspectionFixture } from './helpers/inspection-fixture.mjs';

for (const format of ['sha1', 'sha256']) {
  test(`inspects real ${format} history without contacting a remote or changing refs/index`, async t => {
    const f = inspectionFixture(t, format), index = join(f.root, '.git', 'index');
    utimesSync(index, new Date('2000-01-01'), new Date('2000-01-01'));
    const bytes = readFileSync(index), mtime = statSync(index, { bigint: true }).mtimeNs;
    const refs = f.git('for-each-ref', '--format=%(refname) %(objectname)');
    const result = await inspectRetirements(f.options);
    assert.equal(result.inspectionOnly, true); assert.equal(result.networkAccess, false); assert.equal(result.refMutations, false);
    assert.equal(result.remoteFreshness, 'unverified-local-cache'); assert.equal(result.source.objectFormat, format);
    assert.deepEqual(result.plan.remote.map(entry => entry.basis), ['ancestry', 'reviewed-head']);
    assert.deepEqual(result.plan.align, ['live']);
    assert.equal(f.git('for-each-ref', '--format=%(refname) %(objectname)'), refs);
    assert.deepEqual(readFileSync(index), bytes); assert.equal(statSync(index, { bigint: true }).mtimeNs, mtime);
  });
}

test('checks actual push URLs and effective pushInsteadOf rewrites independently of fetch', async t => {
  const f = inspectionFixture(t);
  f.git('remote', 'set-url', '--push', 'origin', 'https://other.test/team/repo.git');
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_REMOTE_DESTINATION' });
  f.git('config', '--unset-all', 'remote.origin.pushurl');
  f.git('config', 'url.ssh://git@other.test/.pushInsteadOf', 'https://example.test/');
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_REMOTE_DESTINATION' });
  const result = await inspectRetirements({ ...f.options, expectedRemoteUrls: [f.url, 'ssh://git@other.test/team/repo.git'] });
  assert.equal(result.transport.pushUrl, 'ssh://git@other.test/team/repo.git');
});

test('checks actual fetch insteadOf rewrites and rejects multiple effective push URLs', async t => {
  const f = inspectionFixture(t);
  f.git('config', 'url.https://other.test/.insteadOf', 'https://example.test/');
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_REMOTE_DESTINATION' });
  f.git('config', '--unset-all', 'url.https://other.test/.insteadOf');
  f.git('config', '--add', 'remote.origin.pushurl', f.url);
  f.git('config', '--add', 'remote.origin.pushurl', 'git@example.test:team/repo.git');
  await assert.rejects(inspectRetirements({ ...f.options, expectedRemoteUrls: [f.url, 'git@example.test:team/repo.git'] }), { code: 'ERR_REMOTE_DESTINATION' });
});

test('refuses credential-bearing effective URLs without echoing them', async t => {
  const f = inspectionFixture(t); f.git('remote', 'set-url', '--push', 'origin', 'https://user:synthetic-secret@example.test/team/repo.git');
  await assert.rejects(inspectRetirements(f.options), error => {
    assert.equal(error.code, 'ERR_REMOTE_URL'); assert.doesNotMatch(error.message, /synthetic-secret|user:|example\.test/); return true;
  });
});

test('rejects incomplete, negative and extra-destination fetch refspecs', async t => {
  const f = inspectionFixture(t);
  f.git('config', '--replace-all', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_FETCH_REFSPEC' });
  f.git('config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  f.git('config', '--add', 'remote.origin.fetch', '^refs/heads/hidden');
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_FETCH_REFSPEC' });
});

test('refuses mirror, implicit push refspec and follow-tags configuration', async t => {
  const f = inspectionFixture(t);
  for (const [key, value] of [['remote.origin.mirror', 'true'], ['remote.origin.push', 'refs/heads/*:refs/heads/*'], ['push.followTags', 'true']]) {
    f.git('config', key, value);
    await assert.rejects(inspectRetirements(f.options), { code: 'ERR_PUSH_CONFIGURATION' });
    f.git('config', '--unset-all', key);
  }
});

test('refuses tracked/untracked changes, detached HEAD and the wrong attached branch', async t => {
  const f = inspectionFixture(t), extra = join(f.root, 'untracked.txt');
  writeFileSync(extra, 'preserve me'); await assert.rejects(inspectRetirements(f.options), { code: 'ERR_DIRTY_SOURCE' }); rmSync(extra);
  writeFileSync(join(f.root, 'base.txt'), 'changed'); await assert.rejects(inspectRetirements(f.options), { code: 'ERR_DIRTY_SOURCE' });
  f.git('restore', 'base.txt'); f.git('switch', '--detach', '--quiet');
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_DETACHED_SOURCE' });
  f.git('switch', '--quiet', 'live'); await assert.rejects(inspectRetirements(f.options), { code: 'ERR_SOURCE_BRANCH' });
});

test('refuses stale remote-tracking integration and divergent permanent heads', async t => {
  const f = inspectionFixture(t);
  f.git('update-ref', 'refs/remotes/origin/main', f.base);
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_SOURCE_ALIGNMENT' });
  f.git('update-ref', 'refs/remotes/origin/main', f.target); f.git('update-ref', 'refs/remotes/origin/live', f.base);
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_PERMANENT_ALIGNMENT' });
});

test('refuses active linked, detached, locked and prunable extra worktrees without removing them', async t => {
  const f = inspectionFixture(t), linked = join(f.directory, 'extra\nworktree');
  f.git('worktree', 'add', '--quiet', '--detach', linked);
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_WORKTREE' });
  f.git('worktree', 'lock', '--reason', 'preserve synthetic work', linked);
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_WORKTREE' });
  f.git('worktree', 'unlock', linked); rmSync(linked, { recursive: true, force: true });
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_WORKTREE' });
  assert.match(f.git('worktree', 'list', '--porcelain'), /prunable/);
});

test('refuses shallow, replacement and grafted histories and promisor configuration', async t => {
  const f = inspectionFixture(t), shallow = join(f.root, '.git', 'shallow');
  writeFileSync(shallow, f.target + '\n'); await assert.rejects(inspectRetirements(f.options), { code: 'ERR_SHALLOW_HISTORY' }); rmSync(shallow);
  f.git('update-ref', `refs/replace/${f.base}`, f.squashed);
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_REPLACED_HISTORY' }); f.git('update-ref', '-d', `refs/replace/${f.base}`);
  const graft = join(f.root, '.git', 'info', 'grafts'); writeFileSync(graft, f.target + '\n');
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_REPLACED_HISTORY' }); rmSync(graft);
  f.git('config', 'remote.origin.promisor', 'true'); await assert.rejects(inspectRetirements(f.options), { code: 'ERR_PARTIAL_HISTORY' });
});

test('refuses a graft FIFO rather than reading or blocking on it', async t => {
  const f = inspectionFixture(t), graft = join(f.root, '.git', 'info', 'grafts');
  assert.equal(spawnSync('mkfifo', [graft]).status, 0);
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_REPLACED_HISTORY' });
});

test('refuses executable content filters before status can execute them', async t => {
  const f = inspectionFixture(t), sentinel = join(f.directory, 'filter-ran');
  f.git('config', 'filter.synthetic.clean', `touch '${sentinel}'`);
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_EXTERNAL_FILTER' });
  assert.throws(() => statSync(sentinel), { code: 'ENOENT' });
});

test('ignores repository overrides and never invokes configured credential helpers', async t => {
  const f = inspectionFixture(t), sentinel = join(f.directory, 'credential-ran');
  f.git('config', 'credential.helper', `!touch '${sentinel}'`);
  const before = process.env.GIT_DIR; process.env.GIT_DIR = '/nonexistent-synthetic-repository';
  try { assert.equal((await inspectRetirements(f.options)).source.root, f.root); }
  finally { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; }
  assert.throws(() => statSync(sentinel), { code: 'ENOENT' });
});

test('enforces output/inspection deadlines and supports cancellation', async t => {
  const f = inspectionFixture(t);
  const input = Array.from({ length: 40 }, (_, i) => `create refs/remotes/origin/feat/branch-${i} ${f.target}\n`).join('');
  const created = spawnSync('git', ['update-ref', '--stdin'], { cwd: f.root, env: f.env, input, encoding: 'utf8' });
  assert.equal(created.status, 0);
  await assert.rejects(inspectRetirements({ ...f.options, maxOutputBytes: 1024 }), { code: 'ERR_GIT_OUTPUT_LIMIT' });
  await assert.rejects(inspectRetirements({ ...f.options, timeoutMs: 1 }), { code: 'ERR_GIT_TIMEOUT' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectRetirements({ ...f.options, signal: controller.signal }), { code: 'ERR_ABORTED' });
});

test('refuses non-UTF-8 branch output and symbolic non-HEAD branch refs', async t => {
  const f = inspectionFixture(t), path = Buffer.concat([Buffer.from(join(f.root, '.git', 'refs', 'heads', 'feat') + '/'), Buffer.from([255])]);
  writeFileSync(path, f.target + '\n'); await assert.rejects(inspectRetirements(f.options), { code: 'ERR_GIT_ENCODING' }); rmSync(path);
  f.git('symbolic-ref', 'refs/remotes/origin/feat/symbolic', 'refs/remotes/origin/main');
  await assert.rejects(inspectRetirements(f.options), { code: 'ERR_SYMBOLIC_REF' });
});

test('validates paths, root/configuration and endpoint inputs before using them', async t => {
  const f = inspectionFixture(t); mkdirSync(join(f.root, 'subdirectory'));
  await assert.rejects(inspectRetirements({ ...f.options, cwd: join(f.root, 'subdirectory') }), { code: 'ERR_REPOSITORY_ROOT' });
  await assert.rejects(inspectRetirements({ ...f.options, cwd: join(f.directory, 'missing') }), { code: 'ERR_REPOSITORY_PATH' });
  for (const change of [{ remote: '--option' }, { integrationBranch: 'unknown' }, { timeoutMs: null },
    { maxOutputBytes: 1 }, { expectedRemoteUrls: [] }, { expectedRemoteUrls: null }, { signal: {} }]) {
    await assert.rejects(inspectRetirements({ ...f.options, ...change }));
  }
});

test('refuses a real ref change occurring between the initial and final snapshots', async t => {
  const f = inspectionFixture(t), bin = join(f.directory, 'bin'), flag = join(f.directory, 'changed');
  mkdirSync(bin);
  const oldPath = process.env.PATH;
  const realGit = realpathSync(oldPath.split(delimiter).map(dir => join(dir, 'git')).find(path => existsSync(path)));
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!${process.execPath}\n` + `
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
const executable = ${JSON.stringify(realGit)}, flag = ${JSON.stringify(flag)};
const args = process.argv.slice(2);
if (args.includes('merge-base') && !existsSync(flag)) {
  writeFileSync(flag, 'fixture mutation');
  execFileSync(executable, ['-C', ${JSON.stringify(f.root)}, 'update-ref', 'refs/remotes/origin/feat/concurrent', ${JSON.stringify(f.target)}]);
}
const result = spawnSync(executable, args, { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
`);
  chmodSync(wrapper, 0o700); process.env.PATH = bin + delimiter + oldPath;
  try { await assert.rejects(inspectRetirements({ ...f.options, timeoutMs: 30000 }), { code: 'ERR_INSPECTION_CHANGED' }); }
  finally { process.env.PATH = oldPath; }
  assert.equal(f.git('rev-parse', 'refs/remotes/origin/feat/concurrent'), f.target);
});
