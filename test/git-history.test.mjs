import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planRetirements } from '../src/index.mjs';

// Only disposable local repositories; no network, push, credential helper or live ref operation.
function fixture(t, format) {
  const cwd = mkdtempSync(join(tmpdir(), 'git-guardrails-history-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const command = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  });
  const git = (...args) => {
    const result = command(...args);
    assert.equal(result.status, 0, `Fixture git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=trunk', `--object-format=${format}`);
  writeFileSync(join(cwd, 'base.txt'), 'shared base\n'); git('add', 'base.txt'); git('commit', '--quiet', '-m', 'Base');
  const base = git('rev-parse', 'HEAD');
  git('branch', 'task/ancestral'); git('switch', '--quiet', '-c', 'task/squashed');
  writeFileSync(join(cwd, 'change.txt'), 'accepted fixture change\n'); git('add', 'change.txt'); git('commit', '--quiet', '-m', 'Feature');
  const head = git('rev-parse', 'HEAD');
  git('switch', '--quiet', 'trunk'); git('merge', '--squash', 'task/squashed'); git('commit', '--quiet', '-m', 'Squash integration');
  const target = git('rev-parse', 'HEAD');
  // Verify that this fixture really has equivalent changes and non-ancestral squash history.
  assert.equal(git('diff', base, head), git('diff', base, target));
  assert.equal(command('merge-base', '--is-ancestor', head, target).status, 1);
  function isAncestor(sha, into) {
    const result = command('merge-base', '--is-ancestor', sha, into);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error('Fixture ancestry inspection failed.');
  }
  return { base, head, target, isAncestor, git };
}

for (const format of ['sha1', 'sha256']) {
  test(`real ${format} history distinguishes ancestry, reviewed squash and a different target`, async t => {
    const { base, head, target, isAncestor } = fixture(t, format);
    const repository = `example.test/fixtures/${format}`;
    const input = {
      repository, objectFormat: format, permanent: ['trunk', 'stable'], temporaryPrefixes: ['task/'],
      remote: { trunk: target, stable: target, 'task/ancestral': base, 'task/squashed': head },
      local: { trunk: target }, isAncestor,
      reviewedHeads: [{ repository, branch: 'task/squashed', head, target, evidence: 'fixture/equivalent-diff-reviewed' }],
    };
    const plan = await planRetirements(input);
    assert.deepEqual(plan.remote.map(x => x.basis), ['ancestry', 'reviewed-head']);
    assert.deepEqual(plan.align, ['stable']);
    await assert.rejects(planRetirements({ ...input, reviewedHeads: [] }), { code: 'ERR_UNREVIEWED_WORK' });
    await assert.rejects(planRetirements({ ...input, local: {}, remote: { ...input.remote, trunk: base, stable: base } }), { code: 'ERR_UNREVIEWED_WORK' });
  });
}

test('supported branch-name examples agree with Git validation and produce retirement entries', async t => {
  const { git } = fixture(t, 'sha1');
  const target = git('rev-parse', 'HEAD');
  for (const name of ['feat/nested/change', 'fix/issue-123', 'feat/éclair', 'feat/at@name', 'feat/end]']) {
    assert.equal(git('check-ref-format', '--branch', name), name);
    const plan = await planRetirements({ repository: 'example.test/fixtures/names', permanent: ['main', 'live'],
      remote: { main: target, live: target, [name]: target }, local: {}, isAncestor: () => false });
    assert.equal(plan.remote[0].branch, name);
  }
});
