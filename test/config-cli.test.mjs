import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, symlinkSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import metadata from '../package.json' with { type: 'json' };
import { readRetirementConfig, inspectRetirements } from '../src/node/index.mjs';
import { inspectionFixture } from './helpers/inspection-fixture.mjs';

const cli = fileURLToPath(new URL('../bin/git-release-guardrails.mjs', import.meta.url));
function fixture(t) {
  const f = inspectionFixture(t), file = join(f.directory, 'config.json');
  const { cwd, ...options } = f.options;
  const config = { schemaVersion: 1, ...options };
  writeFileSync(file, JSON.stringify(config));
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: f.directory, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
  return { ...f, config, file, invoke };
}

test('loads ordinary declarative data and normalizes endpoints without using environment interpolation', async t => {
  const f = fixture(t);
  f.config.repository = '${HOME}/opaque-identity';
  f.config.expectedRemoteUrls = ['git@EXAMPLE.TEST:team/repo.git'];
  writeFileSync(f.file, JSON.stringify(f.config));
  const value = await readRetirementConfig(f.file);
  assert.equal(value.repository, '${HOME}/opaque-identity');
  assert.deepEqual(value.expectedRemoteUrls, ['ssh://git@example.test/team/repo.git']);
  assert.equal(value.timeoutMs, 10000); assert.equal(Object.hasOwn(value, 'schemaVersion'), false);
});

test('refuses malformed schemas, execution fields, credentials, reviews and unsupported limits', async t => {
  const f = fixture(t);
  const changes = [{ schemaVersion: 2 }, { schemaVersion: undefined }, { execute: 'anything' }, { cwd: f.root },
    { expectedRemoteUrls: ['https://secret@example.test/repo'] }, { permanent: [] }, { permanent: ['other'] },
    { remote: '-option' }, { temporaryPrefixes: ['feat'] }, { timeoutMs: 30001 }, { maxOutputBytes: 2 },
    { reviewedHeads: [{ ...f.config.reviewedHeads[0], head: 'invalid' }] },
    { reviewedHeads: [f.config.reviewedHeads[0], f.config.reviewedHeads[0]] }];
  for (const change of changes) {
    writeFileSync(f.file, JSON.stringify({ ...f.config, ...change }));
    await assert.rejects(readRetirementConfig(f.file), error => error.code.startsWith('ERR_') && !error.message.includes('secret'));
  }
});

test('rejects duplicate keys including escaped aliases and duplicates in review records', async t => {
  const f = fixture(t);
  for (const source of ['{"schemaVersion":1,"schemaVersion":2}', '{"schemaVersion":1,"schema\\u0056ersion":1}',
    JSON.stringify(f.config).replace('"evidence":', '"evidence":"old","evidence":')]) {
    writeFileSync(f.file, source);
    await assert.rejects(readRetirementConfig(f.file), { code: 'ERR_CONFIG_JSON' });
  }
  // The same key in separate objects is unambiguous.
  f.config.reviewedHeads.push({ ...f.config.reviewedHeads[0], branch: 'fix/other' });
  writeFileSync(f.file, JSON.stringify(f.config));
  assert.equal((await readRetirementConfig(f.file)).reviewedHeads.length, 2);
});

test('bounds file bytes and nesting; rejects invalid JSON and non-UTF-8', async t => {
  const f = fixture(t);
  for (const source of ['[', '\ufeff' + JSON.stringify(f.config), Buffer.from([0xff]), '['.repeat(33) + '0' + ']'.repeat(33)]) {
    writeFileSync(f.file, source);
    await assert.rejects(readRetirementConfig(f.file), { code: 'ERR_CONFIG_JSON' });
  }
  writeFileSync(f.file, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(readRetirementConfig(f.file), { code: 'ERR_CONFIG_LIMIT' });
});

test('refuses missing files, directories, final symlinks and FIFOs without hanging', async t => {
  const f = fixture(t), link = join(f.directory, 'link.json'), folder = join(f.directory, 'folder');
  symlinkSync(f.file, link); mkdirSync(folder);
  for (const path of [link, folder, join(f.directory, 'missing')]) await assert.rejects(readRetirementConfig(path), { code: 'ERR_CONFIG_FILE' });
  const fifo = join(f.directory, 'pipe.json');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  const result = f.invoke('preview', '--config', fifo, '--json');
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).error.code, 'ERR_CONFIG_FILE');
});

test('cancelled config reads fail before opening a path and reject accessor options', async () => {
  await assert.rejects(readRetirementConfig('/not-read', { signal: AbortSignal.abort() }), { code: 'ERR_ABORTED' });
  await assert.rejects(readRetirementConfig('/not-read', { get signal() { assert.fail('do not invoke getter'); } }), { code: 'ERR_INPUT' });
});

test('help and version work without a Git executable or configuration', () => {
  for (const flag of ['--help', '--version']) {
    const result = spawnSync(process.execPath, [cli, flag], { env: { PATH: '/nonexistent' }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    if (flag === '--help') assert.match(result.stdout, /Preview integrated temporary branches/);
    else assert.equal(result.stdout, `${metadata.name}@${metadata.version}\n`);
  }
});

test('CLI handles SIGINT and SIGTERM during Git work with documented exit codes', { timeout: 10000 }, async t => {
  const f = fixture(t), bin = join(f.directory, 'delayed-bin'); mkdirSync(bin);
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const ready = join(f.directory, signal + '-ready');
    const wrapper = join(bin, 'git');
    writeFileSync(wrapper, `#!${process.execPath}\n` + `
      require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');
      setTimeout(() => {}, 3000);
    `); chmodSync(wrapper, 0o700);
    const child = spawn(process.execPath, [cli, 'preview', '--config', f.file, '--cwd', f.root, '--json'], {
      env: { PATH: bin, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const closed = new Promise((resolve, reject) => { child.once('close', (code, by) => resolve({ code, by })); child.once('error', reject); });
    const deadline = performance.now() + 2000;
    while (!existsSync(ready) && performance.now() < deadline) await delay(10);
    assert.ok(existsSync(ready), 'wait for a real owned Git subprocess before signalling the CLI');
    child.kill(signal);
    assert.deepEqual(await closed, { code: exitCode, by: null });
    assert.equal(stdout, ''); assert.equal(JSON.parse(stderr).error.code, 'ERR_ABORTED');
  }
});

test('CLI preview matches the API and leaves every ref, source file and config unchanged', async t => {
  const f = fixture(t);
  const before = f.git('show-ref'), contents = readFileSync(join(f.root, 'change.txt')), config = readFileSync(f.file);
  const result = f.invoke('preview', '--config', 'config.json', '--cwd', f.root, '--json');
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const data = JSON.parse(result.stdout);
  assert.equal(data.schemaVersion, 1); assert.equal(data.ok, true); assert.equal(data.command, 'preview');
  assert.deepEqual(data.result, await inspectRetirements(f.options));
  assert.equal(f.git('show-ref'), before); assert.deepEqual(readFileSync(join(f.root, 'change.txt')), contents);
  assert.deepEqual(readFileSync(f.file), config); assert.equal(f.git('status', '--porcelain'), '');
  const human = f.invoke('preview', '--config', f.file, '--cwd', f.root);
  assert.equal(human.status, 0); assert.match(human.stdout, /unverified local cache/);
  assert.match(human.stdout, /fix\/squashed.*reviewed-head/u);
});

test('single-main CLI works for SHA-1 and SHA-256 while preserving normal refusal rules', async t => {
  for (const format of ['sha1', 'sha256']) await t.test(format, async t => {
    const f = inspectionFixture(t, format);
    f.git('branch', '-D', 'live'); f.git('update-ref', '-d', 'refs/remotes/origin/live');
    const options = { ...f.options, permanent: ['main'] };
    const result = await inspectRetirements(options);
    assert.deepEqual(result.plan.align, []); assert.equal(result.plan.remote.length, 2);
    const { cwd, ...config } = options;
    const file = join(f.directory, 'one-main.json'); writeFileSync(file, JSON.stringify({ schemaVersion: 1, ...config }));
    const child = spawnSync(process.execPath, [cli, 'preview', '--config', file, '--cwd', f.root, '--json'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).result.source.objectFormat, format);
    f.git('branch', 'unknown');
    await assert.rejects(inspectRetirements(options), { code: 'ERR_UNKNOWN_BRANCH' });
  });
});

test('CLI refusals use stable exit codes, clean output channels and omit raw error input', t => {
  const f = fixture(t), before = f.git('show-ref');
  for (const args of [[], ['apply'], ['preview'], ['preview', '--config', f.file, '--apply'],
    ['preview', '--config', f.file, '--config', f.file], ['preview', '--config', f.file, '--cwd', f.root, 'extra'],
    ['--version', 'preview'], ['--secret=do-not-print']]) {
    const result = f.invoke(...args, '--json');
    assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'ERR_CLI_USAGE'); assert.doesNotMatch(result.stderr, /do-not-print/);
  }
  const config = { ...f.config, expectedRemoteUrls: ['https://user:do-not-print@example.test/repo.git'] };
  writeFileSync(f.file, JSON.stringify(config));
  const invalid = f.invoke('preview', '--config', f.file, '--cwd', f.root, '--json');
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.doesNotMatch(invalid.stderr, /do-not-print/);
  assert.equal(f.git('show-ref'), before);
});

test('backup/verify/restore CLI verifies a fresh bare recovery and preserves source refs', { timeout: 15000 }, t => {
  const f = fixture(t), directory = join(f.directory, 'cli backup'), destination = join(f.directory, 'cli recovery.git');
  const before = f.git('show-ref');
  const backup = f.invoke('backup', '--config', f.file, '--cwd', f.root, '--directory', directory, '--json');
  assert.equal(backup.status, 0, backup.stderr); assert.equal(backup.stderr, '');
  const created = JSON.parse(backup.stdout); assert.equal(created.command, 'backup'); assert.equal(created.result.verified, true);
  const verified = f.invoke('verify-backup', '--directory', directory, '--json');
  assert.equal(verified.status, 0, verified.stderr); assert.deepEqual(JSON.parse(verified.stdout).result, created.result);
  const restored = f.invoke('restore-backup', '--directory', directory, '--destination', destination, '--json');
  assert.equal(restored.status, 0, restored.stderr); assert.equal(JSON.parse(restored.stdout).result.destination, destination);
  const human = f.invoke('verify-backup', '--directory', directory);
  assert.equal(human.status, 0); assert.match(human.stdout, /Verified verify-backup/);
  assert.equal(f.git('show-ref'), before); assert.equal(f.git('status', '--porcelain'), '');
  const refused = f.invoke('restore-backup', '--directory', directory, '--destination', destination, '--json');
  assert.equal(refused.status, 1); assert.equal(JSON.parse(refused.stderr).error.code, 'ERR_BACKUP_DESTINATION');
});

test('backup command selection rejects irrelevant flags, malformed limits and incomplete arguments', t => {
  const f = fixture(t);
  for (const args of [['backup', '--directory', 'new'], ['verify-backup'], ['restore-backup', '--directory', 'old'],
    ['preview', '--config', f.file, '--directory', 'new'], ['verify-backup', '--directory', 'old', '--config', f.file],
    ['backup', '--config', f.file, '--directory', 'new', '--timeout-ms', '01'],
    ['backup', '--config', f.file, '--directory', 'new', '--max-backup-bytes', '1e6']]) {
    const result = f.invoke(...args, '--json'); assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'ERR_CLI_USAGE');
  }
  const bounded = f.invoke('backup', '--config', f.file, '--cwd', f.root, '--directory', 'new', '--timeout-ms', '30001', '--json');
  assert.equal(bounded.status, 1); assert.equal(JSON.parse(bounded.stderr).error.code, 'ERR_INPUT');
});
