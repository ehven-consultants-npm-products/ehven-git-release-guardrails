import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRemoteDestinations, normalizeRemoteUrl } from '../src/remote.mjs';

test('normalizes only equivalent URL syntax, retaining path case, .git and transport identity', () => {
  assert.equal(normalizeRemoteUrl('git@EXAMPLE.test:Team/Repo.git'), 'ssh://git@example.test/Team/Repo.git');
  assert.equal(normalizeRemoteUrl('ssh://git@example.test:22/Team/Repo.git'), 'ssh://git@example.test/Team/Repo.git');
  assert.equal(normalizeRemoteUrl('https://EXAMPLE.test:443/Team/Repo.git'), 'https://example.test/Team/Repo.git');
  assert.notEqual(normalizeRemoteUrl('https://example.test/Team/Repo'), normalizeRemoteUrl('https://example.test/Team/Repo.git'));
  assert.notEqual(normalizeRemoteUrl('https://example.test/Team/Repo.git'), normalizeRemoteUrl('https://example.test/team/Repo.git'));
  assert.notEqual(normalizeRemoteUrl('ssh://git@example.test:2222/Team/Repo.git'), normalizeRemoteUrl('git@example.test:Team/Repo.git'));
});

test('checks effective fetch and push independently against deliberately approved endpoints', () => {
  const expectedRemoteUrls = ['https://example.test/team/repo.git', 'git@example.test:team/repo.git'];
  assert.deepEqual(assertRemoteDestinations({ expectedRemoteUrls, fetchUrls: [expectedRemoteUrls[0]], pushUrls: [expectedRemoteUrls[1]] }),
    { fetchUrl: expectedRemoteUrls[0], pushUrl: 'ssh://git@example.test/team/repo.git' });
  for (const change of [{ pushUrls: ['https://another.test/team/repo.git'] }, { fetchUrls: ['https://example.test/other/repo.git'] },
    { pushUrls: expectedRemoteUrls }, { fetchUrls: [] }]) {
    assert.throws(() => assertRemoteDestinations({ expectedRemoteUrls, fetchUrls: [expectedRemoteUrls[0]], pushUrls: [expectedRemoteUrls[0]], ...change }), { code: 'ERR_REMOTE_DESTINATION' });
  }
});

test('rejects credentials, token/query URLs, path aliases and unsupported transports without echoing inputs', () => {
  for (const value of ['https://user:secret@example.test/team/repo.git', 'https://user@example.test/team/repo.git',
    'https://example.test/repo.git?token=secret', 'https://example.test/repo.git#secret',
    'https://example.test/team/../repo.git', 'https://example.test/team/%2e%2e/repo.git',
    'https://example.test/team%2frepo.git', 'https://example.test/team/%5crepo.git',
    'http://example.test/repo.git', 'file:///tmp/repo.git', 'ext::anything', '/tmp/local.git',
    'https://example.test/', 'https://example.test//repo.git', 'https://example.test/repo.git/',
    'ssh://git:secret@example.test/repo.git', 'https://example.test/%00repo.git', 'https://example.test/%zz',
  ]) {
    assert.throws(() => normalizeRemoteUrl(value), error => {
      assert.ok(['ERR_REMOTE_URL', 'ERR_INPUT'].includes(error.code));
      assert.doesNotMatch(error.message, /secret|token=|anything|example\.test/); return true;
    });
  }
});

test('rejects ambiguous duplicate approvals and malformed destination collections', () => {
  const endpoint = 'https://example.test/repo.git';
  for (const expectedRemoteUrls of [[], null, Array(2), [endpoint, endpoint], Array(9).fill(endpoint)]) {
    assert.throws(() => assertRemoteDestinations({ expectedRemoteUrls, fetchUrls: [endpoint], pushUrls: [endpoint] }));
  }
});
