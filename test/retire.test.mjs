import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyRetirement, recoverRetirement, validateLiveRetirement, verifyRetirementBackup } from '../src/node/index.mjs';
import { inspectionFixture } from './helpers/inspection-fixture.mjs';

function fixture(t, format = 'sha1') {
  const f = inspectionFixture(t, format);
  const target = join(f.directory, 'remote.git'), directory = join(f.directory, 'operation');
  const bin = join(f.directory, 'bin'), mode = join(f.directory, 'fixture-mode'), log = join(f.directory, 'pushes');
  const oldPath = process.env.PATH;
  const git = oldPath.split(delimiter).map(d => join(d, 'git')).find(existsSync);
  const server = (...args) => execFileSync(git, ['--git-dir=' + target, ...args], { env: f.env, encoding: 'utf8' }).trim();
  execFileSync(git, ['clone', '--quiet', '--bare', '--no-local', '--', f.root, target], { env: f.env });
  server('update-ref', 'refs/heads/live', f.target);
  const endpoint = 'git@remote.example.test:owner/repo.git';
  f.git('remote', 'set-url', 'origin', endpoint);
  mkdirSync(bin);
  process.env.PATH = bin + delimiter + oldPath;
  t.after(() => { process.env.PATH = oldPath; });

  writeFileSync(join(bin, 'ssh'), `#!${process.execPath}\n
const fs=require('node:fs'),{spawnSync}=require('node:child_process');
const git=${JSON.stringify(git)}, repo=${JSON.stringify(target)}, mode=${JSON.stringify(mode)}, log=${JSON.stringify(log)};
const args=process.argv.slice(2);
if(!args.includes('git@remote.example.test'))process.exit(91);
const command=args.at(-1);
const receive=command===\"git-receive-pack 'owner/repo.git'\";
if(!receive&&command!==\"git-upload-pack 'owner/repo.git'\")process.exit(92);
const fault=fs.existsSync(mode)?fs.readFileSync(mode,'utf8'):'';
if(receive){
 fs.appendFileSync(log,'receive\\n');
 if(!fs.existsSync(${JSON.stringify(join(directory, 'retirement.json'))}))process.exit(93);
 if(fault==='move-remote') {
   const r=spawnSync(git,['--git-dir='+repo,'update-ref','refs/heads/feat/merged',${JSON.stringify(f.target)}]);
   if(r.status!==0)process.exit(94);
 }
}
const result=spawnSync(git,[receive?'receive-pack':'upload-pack',repo],{stdio:'inherit'});
process.exit(result.status??1);
`, { mode: 0o700 });

  const options = { ...f.options, expectedRemoteUrls: [endpoint], timeoutMs: 20000 };
  function refuseLocal() {
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
if(args.includes('update-ref')&&args.includes('--stdin'))process.exit(99);
const child=spawnSync(${JSON.stringify(git)},args,{env:process.env,stdio:'inherit'});process.exit(child.status??1);
`, { mode: 0o700 });
  }
  function moveLocalDuringTransaction() {
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2), git=${JSON.stringify(git)};
if(args.includes('update-ref')&&args.includes('--stdin')){
 const moved=spawnSync(git,['update-ref','refs/heads/feat/merged',${JSON.stringify(f.target)}],{stdio:'ignore'});
 if(moved.status!==0)process.exit(97);
}
const child=spawnSync(git,args,{env:process.env,stdio:'inherit'});process.exit(child.status??1);
`, { mode: 0o700 });
  }
  function injectAtGitCommand(code) {
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2), git=${JSON.stringify(git)};
${code}
const child=spawnSync(git,args,{env:process.env,stdio:'inherit'});process.exit(child.status??1);
`, { mode: 0o700 });
  }
  return { ...f, options, server, directory, endpoint, bin, mode, log, refuseLocal, moveLocalDuringTransaction, injectAtGitCommand };
}

async function prepare(f) {
  const preview = await validateLiveRetirement(f.options);
  assert.match(preview.planId, /^[a-f0-9]{64}$/u);
  assert.equal((await validateLiveRetirement(f.options)).planId, preview.planId);
  return { inspection: f.options, directory: f.directory, expectedPlanId: preview.planId };
}

function remoteNames(f) {
  return f.server('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n');
}
function localNames(f) { return f.git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n'); }
function trackingNames(f) { return f.git('for-each-ref', '--format=%(refname)', 'refs/remotes').split('\n'); }

for (const format of ['sha1', 'sha256']) test(`atomic retirement/recovery end to end in ${format}`, async t => {
  const f = fixture(t, format), request = await prepare(f);
  const index = readFileSync(join(f.root, '.git', 'index'));
  const result = await applyRetirement(request);
  assert.deepEqual(result, { completed: true, recovered: false, planId: request.expectedPlanId, directory: f.directory,
    remoteRetired: 2, localRetired: 2, localAligned: 1 });
  assert.deepEqual(remoteNames(f), ['live', 'main']);
  assert.deepEqual(localNames(f), ['live', 'main']);
  assert.deepEqual(trackingNames(f), ['refs/remotes/origin/HEAD', 'refs/remotes/origin/live', 'refs/remotes/origin/main']);
  assert.deepEqual(readFileSync(join(f.root, '.git', 'index')), index);
  assert.equal(f.git('rev-parse', 'refs/heads/live'), f.target);
  assert.ok((await verifyRetirementBackup({ directory: f.directory })).verified);
  assert.equal((await recoverRetirement(request)).recovered, true);
  assert.equal(readFileSync(f.log, 'utf8'), 'receive\n');
  assert.equal(existsSync(join(f.root, '.git', 'ehven-retirement.lock')), false);
});

test('stale or incorrect plan ID and a competing lock refuse before backup or push', async t => {
  const f = fixture(t), request = await prepare(f);
  await assert.rejects(applyRetirement({ ...request, expectedPlanId: '0'.repeat(64) }), { code: 'ERR_RETIREMENT_PLAN' });
  const lock = join(f.root, '.git', 'ehven-retirement.lock');
  writeFileSync(lock, 'test lock');
  await assert.rejects(applyRetirement(request), { code: 'ERR_RETIREMENT_LOCK' });
  assert.equal(readFileSync(lock, 'utf8'), 'test lock');
  assert.equal(existsSync(f.directory), false); assert.equal(existsSync(f.log), false);
});

test('movement of one leased branch rejects the whole atomic deletion', async t => {
  const f = fixture(t), request = await prepare(f);
  writeFileSync(f.mode, 'move-remote');
  await assert.rejects(applyRetirement(request), { code: 'ERR_RETIREMENT_PUSH' });
  assert.equal(f.server('rev-parse', 'refs/heads/feat/merged'), f.target);
  assert.ok(remoteNames(f).includes('fix/squashed')); assert.ok(localNames(f).includes('feat/merged'));
  assert.ok(existsSync(join(f.directory, 'retirement.json')));
  await assert.rejects(recoverRetirement(request), { code: 'ERR_RETIREMENT_CHANGED' });
});

test('server without atomic capability preserves all branches and allows exact recovery after capability returns', async t => {
  const f = fixture(t), request = await prepare(f);
  f.server('config', 'receive.advertiseAtomic', 'false');
  await assert.rejects(applyRetirement(request), { code: 'ERR_RETIREMENT_PUSH' });
  assert.equal(remoteNames(f).length, 4); assert.equal(localNames(f).length, 4);
  f.server('config', 'receive.advertiseAtomic', 'true');
  assert.equal((await recoverRetirement(request)).recovered, true);
  assert.deepEqual(remoteNames(f), ['live', 'main']);
});

test('journal resumes a completed remote push after the local transaction is interrupted', async t => {
  const f = fixture(t), request = await prepare(f);
  f.refuseLocal();
  await assert.rejects(applyRetirement(request), { code: 'ERR_RETIREMENT_LOCAL' });
  assert.deepEqual(remoteNames(f), ['live', 'main']);
  assert.equal(localNames(f).length, 4);
  rmSync(join(f.bin, 'git'));
  assert.equal((await recoverRetirement(request)).recovered, true);
  assert.deepEqual(localNames(f), ['live', 'main']);
  assert.equal(readFileSync(f.log, 'utf8'), 'receive\n');
});

test('local compare-and-swap preserves concurrent work and refuses recovery on an unexpected state', async t => {
  const f = fixture(t), request = await prepare(f);
  f.moveLocalDuringTransaction();
  await assert.rejects(applyRetirement(request), { code: 'ERR_RETIREMENT_LOCAL' });
  rmSync(join(f.bin, 'git'));
  assert.equal(f.git('rev-parse', 'refs/heads/feat/merged'), f.target);
  assert.equal(f.git('rev-parse', 'refs/heads/fix/squashed'), f.squashed);
  assert.ok(trackingNames(f).includes('refs/remotes/origin/feat/merged'));
  await assert.rejects(recoverRetirement(request), { code: 'ERR_RETIREMENT_CHANGED' });
});

test('an unacknowledged successful push is reconciled without a second deletion attempt', async t => {
  const f = fixture(t), request = await prepare(f);
  f.injectAtGitCommand(`
if(args.includes('push')){
 const result=spawnSync(git,args,{env:process.env,stdio:'inherit'});
 process.exit(result.status===0?98:97);
}`);
  await assert.rejects(applyRetirement(request), { code: 'ERR_RETIREMENT_PUSH' });
  assert.deepEqual(remoteNames(f), ['live', 'main']);
  assert.equal(localNames(f).length, 4);
  rmSync(join(f.bin, 'git'));
  assert.equal((await recoverRetirement(request)).recovered, true);
  assert.equal(readFileSync(f.log, 'utf8'), 'receive\n');
});

test('the prepared local transaction aborts when HEAD changes before locks are acquired', async t => {
  const f = fixture(t), request = await prepare(f);
  f.injectAtGitCommand(`
if(args.includes('update-ref')&&args.includes('--stdin'))
 spawnSync(git,['symbolic-ref','HEAD','refs/heads/feat/merged']);
`);
  await assert.rejects(applyRetirement(request), { code: 'ERR_SOURCE_BRANCH' });
  rmSync(join(f.bin, 'git'));
  assert.equal(f.git('symbolic-ref', 'HEAD'), 'refs/heads/feat/merged');
  assert.equal(localNames(f).length, 4);
  assert.ok(trackingNames(f).includes('refs/remotes/origin/feat/merged'));
  assert.deepEqual(remoteNames(f), ['live', 'main']);
});

test('installed-style CLI requires the plan ID and validates a finished journal', t => {
  const f = fixture(t);
  const { cwd, ...config } = f.options;
  const file = join(f.directory, '..', 'config.json'); writeFileSync(file, JSON.stringify({ schemaVersion: 1, ...config }));
  const cli = fileURLToPath(new URL('../bin/git-release-guardrails.mjs', import.meta.url));
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args, '--cwd', cwd, '--config', file, '--json'],
    { env: process.env, encoding: 'utf8', timeout: 30000 });
  const preview = invoke('preview', '--live');
  assert.equal(preview.status, 0, preview.stderr);
  const id = JSON.parse(preview.stdout).result.planId;
  const refused = invoke('apply', '--directory', f.directory);
  assert.equal(refused.status, 2);
  const applied = invoke('apply', '--directory', f.directory, '--expect-plan', id);
  assert.equal(applied.status, 0, applied.stderr);
  const recovered = invoke('recover', '--directory', f.directory, '--expect-plan', id);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).result.completed, true);
  assert.equal(readFileSync(f.log, 'utf8'), 'receive\n');
});
