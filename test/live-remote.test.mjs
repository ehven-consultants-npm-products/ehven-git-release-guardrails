import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:https';
import { inspectRetirements, validateLiveRetirement } from '../src/node/index.mjs';
import { inspectionFixture } from './helpers/inspection-fixture.mjs';

function fixture(t, format = 'sha1') {
  const f = inspectionFixture(t, format);
  const bin = join(f.directory, 'bin'), log = join(f.directory, 'contacts.jsonl');
  mkdirSync(bin);
  const originalPath = process.env.PATH;
  const realGit = originalPath.split(delimiter).map(dir => join(dir, 'git')).find(existsSync);
  process.env.PATH = bin + delimiter + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  const exec = (cwd, ...args) => execFileSync(realGit, args, { cwd, env: f.env, encoding: 'utf8' }).trim();
  const remote = name => {
    const directory = join(f.directory, name + '.git');
    exec(f.directory, 'clone', '--quiet', '--bare', '--no-local', '--', f.root, directory);
    exec(directory, 'update-ref', 'refs/heads/live', f.target);
    return directory;
  };
  const fetch = remote('fetch'), push = remote('push');
  const record = `const fs=require('node:fs'); const args=process.argv.slice(2); const log=${JSON.stringify(log)};`;
  // Git negotiates the real upload-pack protocol through a disposable SSH shim.
  // The shim maps synthetic hosts to test repositories without external traffic.
  writeFileSync(join(bin, 'ssh'), `#!${process.execPath}\n${record}
const {spawnSync}=require('node:child_process');
fs.appendFileSync(log, JSON.stringify({args, agent:process.env.SSH_AUTH_SOCK??null})+'\\n');
const endpoint=args.find(arg=>arg==='git@pull.example.test'||arg==='git@push.example.test');
if(!endpoint||!args.at(-1).startsWith('git-upload-pack '))process.exit(101);
const directory=endpoint==='git@pull.example.test'?${JSON.stringify(fetch)}:${JSON.stringify(push)};
const result=spawnSync(${JSON.stringify(realGit)},['upload-pack',directory],{stdio:'inherit'});process.exit(result.status??1);
`, { mode: 0o700 });
  const pullUrl = 'git@pull.example.test:owner/repo.git', pushUrl = 'ssh://git@push.example.test/owner/repo.git';
  f.git('remote', 'set-url', 'origin', pullUrl);
  f.git('remote', 'set-url', '--push', 'origin', pushUrl);
  const options = { ...f.options, expectedRemoteUrls: [pullUrl, pushUrl], timeoutMs: 20000 };
  const contacts = () => !existsSync(log) ? [] : readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  function replaceLiveGit(body) {
    writeFileSync(join(bin, 'git'), `#!${process.execPath}\n${record}
const {spawnSync}=require('node:child_process');
if(args.includes('ls-remote')){${body}}
const r=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(r.status??1);
`, { mode: 0o700 });
  }
  return { ...f, options, fetch, push, pullUrl, pushUrl, contacts, exec, replaceLiveGit, realGit };
}

for (const format of ['sha1', 'sha256']) test(`matches both live ${format} advertisements and preserves source and remote refs`, async t => {
  const f = fixture(t, format);
  const source = f.git('show-ref'), index = readFileSync(join(f.root, '.git', 'index'));
  const pull = f.exec(f.fetch, 'show-ref'), push = f.exec(f.push, 'show-ref');
  const local = await inspectRetirements(f.options);
  assert.equal(local.networkAccess, false); assert.deepEqual(f.contacts(), []);
  const live = await validateLiveRetirement(f.options);
  assert.equal(live.remoteFreshness, 'matched-live-advertisement');
  assert.equal(live.networkAccess, true); assert.equal(live.refMutations, false);
  assert.deepEqual(live.plan, local.plan);
  assert.deepEqual({ ...live.observation, checkedAt: null }, { checkedAt: null, fetchBranchCount: 4, pushBranchCount: 4, distinctEndpointsChecked: 2 });
  const contacts = f.contacts(); assert.equal(contacts.length, 2);
  for (const { args } of contacts) {
    assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(args.includes('BatchMode=yes'));
    assert.ok(args.includes('ForwardAgent=no')); assert.match(args.at(-1), /^git-upload-pack /u);
  }
  assert.match(contacts[0].args.at(-1), / 'owner\/repo\.git'$/u);
  assert.match(contacts[1].args.at(-1), / '\/owner\/repo\.git'$/u);
  assert.equal(f.git('show-ref'), source); assert.deepEqual(readFileSync(join(f.root, '.git', 'index')), index);
  assert.equal(f.exec(f.fetch, 'show-ref'), pull); assert.equal(f.exec(f.push, 'show-ref'), push);
});

test('flags added, missing and moved refs even when only the push endpoint has diverged', async t => {
  const f = fixture(t);
  f.exec(f.push, 'update-ref', 'refs/heads/feat/new', f.target);
  f.exec(f.push, 'update-ref', '-d', 'refs/heads/fix/squashed');
  f.exec(f.push, 'update-ref', 'refs/heads/feat/merged', f.target);
  const before = f.git('show-ref');
  await assert.rejects(validateLiveRetirement(f.options), error => error.code === 'ERR_LIVE_REMOTE_STALE'
    && /push endpoint.*1 added, 1 missing, 1 moved/u.test(error.message));
  assert.equal(f.git('show-ref'), before); assert.equal(f.contacts().length, 2);
});

test('queries a shared effective endpoint only once, including installed-style CLI JSON', async t => {
  const f = fixture(t);
  f.git('config', '--unset-all', 'remote.origin.pushurl');
  const { cwd, ...config } = { ...f.options, expectedRemoteUrls: [f.pullUrl] };
  const configFile = join(f.directory, 'retirement.json'); writeFileSync(configFile, JSON.stringify({ schemaVersion: 1, ...config }));
  const cli = fileURLToPath(new URL('../bin/git-release-guardrails.mjs', import.meta.url));
  const launched = spawnSync(process.execPath, [cli, 'preview', '--cwd', cwd, '--config', configFile, '--live', '--json'], { env: process.env, encoding: 'utf8', timeout: 15000 });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(JSON.parse(launched.stdout).result.observation.distinctEndpointsChecked, 1);
  assert.equal(f.contacts().length, 1);
});

test('refuses wrong destinations, mismatched SSH path semantics and dirty source before any contact', async t => {
  const f = fixture(t);
  await assert.rejects(validateLiveRetirement({ ...f.options, expectedRemoteUrls: [f.pullUrl] }), { code: 'ERR_REMOTE_DESTINATION' });
  await assert.rejects(validateLiveRetirement({ ...f.options, expectedRemoteUrls: ['ssh://git@pull.example.test/owner/repo.git', f.pushUrl] }), { code: 'ERR_LIVE_REMOTE_URL' });
  writeFileSync(join(f.root, 'untracked'), 'preserve');
  await assert.rejects(validateLiveRetirement(f.options), { code: 'ERR_DIRTY_SOURCE' });
  assert.deepEqual(f.contacts(), []);
});

test('scopes explicit HTTPS authorization and isolates Git config, inherited secrets, and redirects', async t => {
  const f = fixture(t);
  const first = 'https://pull.example.test/owner/repo.git', second = 'https://push.example.test/owner/repo.git';
  f.git('remote', 'set-url', 'origin', first); f.git('remote', 'set-url', '--push', 'origin', second);
  f.git('config', 'http.followRedirects', 'true'); f.git('config', 'http.sslVerify', 'false');
  const ad = f.exec(f.fetch, 'show-ref', '--heads').replaceAll(' ', '\t') + '\n';
  f.replaceLiveGit(`fs.appendFileSync(log,JSON.stringify({args, value:process.env.GIT_CONFIG_VALUE_0??null,
    global:process.env.GIT_CONFIG_GLOBAL, inherited:process.env.EHVEN_TEST_SECRET??null})+'\\n');
    process.stdout.write(${JSON.stringify(ad)});process.exit(0);`);
  const key = 'EHVEN_TEST_SECRET'; const saved = process.env[key]; process.env[key] = 'unrelatedFixtureSecret';
  t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  const data = { ...f.options, expectedRemoteUrls: [first, second] };
  await assert.rejects(validateLiveRetirement({ ...data, httpsAuthorization: { endpoint: 'https://another.example.test/owner/repo.git', value: 'Bearer fixture' } }), { code: 'ERR_LIVE_AUTHORIZATION' });
  await assert.rejects(validateLiveRetirement({ ...data, httpsAuthorization: { endpoint: first, value: 'Bearer fixture\r\nBad: header' } }), { code: 'ERR_LIVE_AUTHORIZATION' });
  assert.deepEqual(f.contacts(), []);
  const result = await validateLiveRetirement({ ...data, httpsAuthorization: { endpoint: first, value: 'Bearer fixture' } });
  assert.doesNotMatch(JSON.stringify(result), /Bearer fixture/u);
  const calls = f.contacts(); assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.global, '/dev/null'); assert.equal(call.inherited, null);
    assert.ok(call.args.includes('--git-dir=/dev/null')); assert.ok(call.args.includes('http.followRedirects=false'));
    assert.ok(call.args.includes('http.sslVerify=true')); assert.ok(call.args.includes('protocol.allow=never'));
    assert.doesNotMatch(JSON.stringify(call.args), /Bearer fixture/u);
  }
  assert.equal(calls[0].value, 'Authorization: Bearer fixture'); assert.equal(calls[1].value, null);
});

test('rejects malformed output, interrupted transport and Git diagnostics without echoing server text', async t => {
  const f = fixture(t);
  for (const payload of [`${f.target}\trefs/heads/main`, `${f.target}\trefs/tags/main\n`, `${f.target}\trefs/heads/main\n${f.target}\trefs/heads/main\n`, `bad\trefs/heads/main\n`]) {
    f.replaceLiveGit(`process.stdout.write(${JSON.stringify(payload)});process.exit(0);`);
    await assert.rejects(validateLiveRetirement(f.options), { code: 'ERR_LIVE_REMOTE_REFS' });
  }
  f.replaceLiveGit("process.stderr.write('synthetic-server-secret');process.exit(128);");
  await assert.rejects(validateLiveRetirement(f.options), error => error.code === 'ERR_LIVE_REMOTE_QUERY' && !error.message.includes('synthetic-server-secret'));
  f.replaceLiveGit("fs.appendFileSync(log,'{}\\n');setTimeout(()=>{},30000);return;");
  const controller = new AbortController();
  const refused = assert.rejects(validateLiveRetirement({ ...f.options, signal: controller.signal }), { code: 'ERR_ABORTED' });
  try {
    const deadline = performance.now() + 10000;
    while (!f.contacts().length && performance.now() < deadline) await delay(15);
    assert.equal(f.contacts().length, 1, 'wait until transport starts before cancelling');
    controller.abort();
    await refused;
  } finally { controller.abort(); }
});

test('Git over verified TLS sends the selected header and refuses an HTTPS redirect', { timeout: 30000 }, async t => {
  const f = fixture(t);
  const key = join(f.directory, 'tls-key.pem'), cert = join(f.directory, 'tls-cert.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(generated.status, 0, generated.stderr);
  const headers = [], paths = [];
  let redirect = false;
  const advertisement = f.exec(f.fetch, 'show-ref', '--heads').replaceAll(' ', '\t') + '\n';
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    paths.push(req.url);
    headers.push(req.headers.authorization);
    if (req.url.startsWith('/owner/repo.git/info/refs')) {
      if (redirect) { res.writeHead(302, { location: '/elsewhere/info/refs' }); res.end(); }
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(advertisement); }
    } else if (req.url === '/owner/repo.git/HEAD') {
      res.end('ref: refs/heads/main\n');
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const endpoint = `https://127.0.0.1:${server.address().port}/owner/repo.git`;
  f.git('remote', 'set-url', 'origin', endpoint);
  f.git('config', '--unset-all', 'remote.origin.pushurl');
  // Trust only the fixture certificate for the real Git command. All production
  // transport flags, authorization plumbing and subprocess isolation stay active.
  f.replaceLiveGit(`args.splice(args.indexOf('ls-remote'),0,'-c',${JSON.stringify('http.sslCAInfo=' + cert)});`);
  const options = { ...f.options, expectedRemoteUrls: [endpoint], httpsAuthorization: { endpoint, value: 'Bearer fixture' } };
  assert.equal((await validateLiveRetirement(options)).remoteFreshness, 'matched-live-advertisement');
  assert.ok(headers.length > 0 && headers.every(header => header === 'Bearer fixture'));
  redirect = true;
  await assert.rejects(validateLiveRetirement(options), { code: 'ERR_LIVE_REMOTE_QUERY' });
  assert.ok(!paths.some(path => path.startsWith('/elsewhere')));
});

test('refuses local ref or endpoint changes after a live advertisement', async t => {
  const f = fixture(t);
  const ad = f.exec(f.fetch, 'show-ref', '--heads').replaceAll(' ', '\t') + '\n';
  f.replaceLiveGit(`spawnSync(${JSON.stringify(f.realGit)}, ['-C',${JSON.stringify(f.root)},'update-ref','refs/heads/feat/new',${JSON.stringify(f.target)}]);
  process.stdout.write(${JSON.stringify(ad)});process.exit(0);`);
  await assert.rejects(validateLiveRetirement(f.options), { code: 'ERR_INSPECTION_CHANGED' });
});
