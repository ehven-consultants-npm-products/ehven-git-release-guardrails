import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { runBounded, inspectionEnvironment } from '../src/node/process.mjs';

const options = { cwd: tmpdir(), timeoutMs: 2000, maxOutputBytes: 4096 };
test('runs without a shell and reports bounded UTF-8 output and exit status', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write(process.argv[1]);process.exitCode=7', 'literal; $(not-a-command)'], options);
  assert.equal(result.status, 7); assert.equal(result.stdout, 'literal; $(not-a-command)');
});
test('enforces subprocess deadline and cancellation, including an already aborted signal', async () => {
  await assert.rejects(runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 100 }), { code: 'ERR_GIT_TIMEOUT' });
  const controller = new AbortController();
  const operation = runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, signal: controller.signal });
  controller.abort(); await assert.rejects(operation, { code: 'ERR_ABORTED' });
  await assert.rejects(runBounded(process.execPath, [], { ...options, signal: controller.signal }), { code: 'ERR_ABORTED' });
});
test('bounds both output streams, rejects malformed UTF-8 and hides subprocess error content', async () => {
  for (const stream of ['stdout', 'stderr']) {
    await assert.rejects(runBounded(process.execPath, ['-e', `process.${stream}.write('x'.repeat(100000))`], options), { code: 'ERR_GIT_OUTPUT_LIMIT' });
  }
  await assert.rejects(runBounded(process.execPath, ['-e', 'process.stdout.write(Buffer.from([255]))'], options), { code: 'ERR_GIT_ENCODING' });
  await assert.rejects(runBounded('/nonexistent/private-secret-git', [], options), error => {
    assert.equal(error.code, 'ERR_GIT_START'); assert.doesNotMatch(error.message, /private-secret/); return true;
  });
});
test('does not forward credential tokens or repository/config-injection overrides', () => {
  const safe = inspectionEnvironment();
  for (const key of ['GITHUB_TOKEN', 'NPM_TOKEN', 'CLOUDFLARE_API_TOKEN', 'NODE_OPTIONS', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND']) {
    assert.equal(Object.hasOwn(safe, key), false);
  }
  assert.equal(safe.GIT_TERMINAL_PROMPT, '0'); assert.equal(safe.GIT_NO_LAZY_FETCH, '1'); assert.equal(safe.GIT_OPTIONAL_LOCKS, '0');
});

test('POSIX timeout stops owned helper descendants that keep output pipes open', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const start = performance.now();
  await assert.rejects(runBounded(process.execPath, ['--input-type=module', '-e',
    "import {spawn} from 'node:child_process'; spawn(process.execPath,['-e','setTimeout(()=>{},3500)'],{stdio:'inherit'}); setTimeout(()=>{},3500);"],
    { cwd: process.cwd(), timeoutMs: 300, maxOutputBytes: 4096 }), { code: 'ERR_GIT_TIMEOUT' });
  assert.ok(performance.now() - start < 2500, 'helper descendant must not hold the cancelled command open');
});
