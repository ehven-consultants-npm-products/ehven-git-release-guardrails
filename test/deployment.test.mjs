import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDeploymentSource } from '../src/index.mjs';

const sha = 'a'.repeat(40);
const source = () => ({ target: 'staging', targets: ['staging', 'live'], sha, localBranch: 'staging', status: '' });

test('accepts configured local or detached/attached matching CI source without a provider', () => {
  assert.deepEqual(assertDeploymentSource(source()), { target: 'staging', sha });
  for (const localBranch of ['', 'staging']) {
    assert.deepEqual(assertDeploymentSource({ ...source(), localBranch, ci: { branch: 'staging', sha } }), { target: 'staging', sha });
  }
});

test('rejects mismatched targets, attached branches, dirty status and CI identity', () => {
  for (const change of [
    { target: 'main' }, { status: ' M source.js' }, { status: '?? untracked' }, { status: '\n' },
    { localBranch: '' }, { localBranch: 'live' }, { ci: { branch: 'live', sha } },
    { ci: { branch: 'staging', sha: 'b'.repeat(40) } },
    { localBranch: 'live', ci: { branch: 'staging', sha } },
  ]) assert.throws(() => assertDeploymentSource({ ...source(), ...change }));
});

test('validates malformed metadata and unsupported fields instead of coercing them', () => {
  for (const value of [undefined, null, [], { ...source(), targets: 'staging' }, { ...source(), targets: [] },
    { ...source(), targets: ['staging', 'staging'] }, { ...source(), sha: '0'.repeat(40) },
    { ...source(), ci: null }, { ...source(), ci: {} }, { ...source(), ci: false },
    { ...source(), status: undefined }, { ...source(), status: { trim: () => '' } },
    { ...source(), localBranch: undefined }, { ...source(), target: 'staging\n' }, { ...source(), approve: true },
  ]) assert.throws(() => assertDeploymentSource(value), error => error.code?.startsWith('ERR_'));
});

test('supports an explicitly selected SHA-256 source and never derives identity from process environment', () => {
  const longSha = 'a'.repeat(64);
  assert.deepEqual(assertDeploymentSource({ ...source(), objectFormat: 'sha256', sha: longSha }), { target: 'staging', sha: longSha });
  // No ci object is provided, so detached source must fail regardless of the host environment.
  assert.throws(() => assertDeploymentSource({ ...source(), localBranch: '' }), { code: 'ERR_DEPLOYMENT_SOURCE' });
});
