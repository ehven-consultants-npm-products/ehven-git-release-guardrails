import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export function inspectionFixture(t, format = 'sha1') {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'git guardrails inspect '));
  const root = join(directory, 'working tree');
  mkdirSync(root);
  const global = join(directory, 'empty-global-config'); writeFileSync(global, '');
  const saved = Object.fromEntries(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map(key => [key, process.env[key]]));
  process.env.GIT_CONFIG_GLOBAL = global; process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(directory, { recursive: true, force: true });
  });
  const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: global,
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  function git(...args) {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: root, env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `Fixture Git ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  }
  git('init', '--quiet', '--initial-branch=main', `--object-format=${format}`);
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(root, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '--quiet', '-m', 'Base');
  const base = git('rev-parse', 'HEAD');
  git('branch', 'feat/merged'); git('branch', 'live');
  git('switch', '--quiet', '-c', 'fix/squashed');
  writeFileSync(join(root, 'change.txt'), 'reviewed squash\n'); git('add', '.'); git('commit', '--quiet', '-m', 'Feature');
  const squashed = git('rev-parse', 'HEAD');
  git('switch', '--quiet', 'main'); git('merge', '--squash', 'fix/squashed'); git('commit', '--quiet', '-m', 'Integrate squash');
  const target = git('rev-parse', 'HEAD');
  const url = 'https://example.test/team/repo.git'; git('remote', 'add', 'origin', url);
  for (const [name, sha] of [['main', target], ['live', target], ['feat/merged', base], ['fix/squashed', squashed]]) {
    git('update-ref', `refs/remotes/origin/${name}`, sha);
  }
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  const repository = 'example.test/team/repo';
  const options = { cwd: root, repository, expectedRemoteUrls: [url], integrationBranch: 'main', permanent: ['main', 'live'],
    reviewedHeads: [{ repository, branch: 'fix/squashed', head: squashed, target, evidence: 'fixture/squash-review' }] };
  return { directory, root, git, env, base, squashed, target, url, options };
}
