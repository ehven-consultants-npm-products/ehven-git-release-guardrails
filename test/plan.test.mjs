import test from 'node:test';
import assert from 'node:assert/strict';
import { planRetirements, GitReleaseGuardError } from '../src/index.mjs';

const target = 'a'.repeat(40), integrated = 'b'.repeat(40), squashed = 'c'.repeat(40), unique = 'd'.repeat(40);
const repository = 'example.test/team/project';
function fixture() {
  return {
    repository, permanent: ['main', 'preview', 'live'],
    remote: { main: target, preview: target, live: target, 'feat/integrated': integrated, 'fix/squashed': squashed },
    local: { main: target, live: integrated },
    reviewedHeads: [{ repository, branch: 'fix/squashed', head: squashed, target, evidence: 'review/17: accepted squash diff' }],
    isAncestor: async sha => sha === integrated,
  };
}
const code = value => error => error instanceof GitReleaseGuardError && error.code === value;

test('plans ancestral and exactly reviewed squash work without mutating inputs', async () => {
  const input = fixture(), before = structuredClone({ ...input, isAncestor: undefined });
  assert.deepEqual(await planRetirements(input), {
    repository, objectFormat: 'sha1', target,
    remote: [
      { branch: 'feat/integrated', sha: integrated, basis: 'ancestry' },
      { branch: 'fix/squashed', sha: squashed, basis: 'reviewed-head', evidence: input.reviewedHeads[0].evidence },
    ], local: [], align: ['live', 'preview'],
  });
  assert.deepEqual({ ...input, isAncestor: undefined }, before);
});

test('rejects a moved local or remote head despite a review of the older head', async () => {
  for (const scope of ['remote', 'local']) {
    const input = fixture(); input[scope]['fix/squashed'] = unique;
    await assert.rejects(planRetirements(input), code('ERR_UNREVIEWED_WORK'));
  }
});

test('squash authorization is scoped to exact repository, branch, head and integration target', async t => {
  for (const change of [
    { repository: 'example.test/another/repository' }, { branch: 'fix/another' },
    { head: unique }, { target: unique },
  ]) {
    await t.test(Object.keys(change)[0], async () => {
      const input = fixture(); Object.assign(input.reviewedHeads[0], change);
      await assert.rejects(planRetirements(input), code('ERR_UNREVIEWED_WORK'));
    });
  }
  const input = fixture(); input.repository = 'example.test/fork/project';
  await assert.rejects(planRetirements(input), code('ERR_UNREVIEWED_WORK'));
});

test('malformed temporary SHAs cannot bypass validation through a matching review', async () => {
  for (const malformed of ['not-a-sha', 'c'.repeat(39), 'C'.repeat(40), '0'.repeat(40), 'c'.repeat(64), squashed + '\n']) {
    const input = fixture(); input.remote['fix/squashed'] = malformed; input.reviewedHeads[0].head = malformed;
    let called = false; input.isAncestor = () => { called = true; return false; };
    await assert.rejects(planRetirements(input), code('ERR_INPUT'));
    assert.equal(called, false);
  }
});

test('rejects malformed permanent/local/review-target commits and all mixed object formats', async () => {
  for (const mutate of [
    input => { input.remote.main = 'invalid'; }, input => { input.local.main = ''; },
    input => { input.reviewedHeads[0].target = '0'.repeat(40); },
    input => { input.reviewedHeads[0].head = 'b'.repeat(64); },
  ]) { const input = fixture(); mutate(input); await assert.rejects(planRetirements(input), code('ERR_INPUT')); }
});

test('refuses permanent divergence or missing remote permanent heads', async () => {
  for (const mutate of [input => { input.remote.live = integrated; }, input => { delete input.remote.preview; }]) {
    const input = fixture(); mutate(input); await assert.rejects(planRetirements(input), code('ERR_PERMANENT_ALIGNMENT'));
  }
});

test('never treats a squash review as permission to overwrite unique permanent history', async () => {
  const input = fixture(); input.local.live = unique;
  input.reviewedHeads.push({ repository, branch: 'live', head: unique, target, evidence: 'review/18' });
  await assert.rejects(planRetirements(input), code('ERR_LOCAL_UNMERGED'));
});

test('unknown long-lived work blocks the full plan before ancestry inspection', async () => {
  const input = fixture(); input.remote.release = target;
  let called = false; input.isAncestor = () => { called = true; return true; };
  await assert.rejects(planRetirements(input), code('ERR_UNKNOWN_BRANCH'));
  assert.equal(called, false);
});

test('supports declarative alternate and nested temporary prefixes and deterministic ordering', async () => {
  const input = { repository, permanent: ['trunk', 'stable'],
    remote: { stable: target, 'task/z/nested': integrated, trunk: target, 'task/a': integrated },
    local: {}, temporaryPrefixes: ['task/'], isAncestor: () => true };
  const plan = await planRetirements(input);
  assert.deepEqual(plan.remote.map(x => x.branch), ['task/a', 'task/z/nested']);
  assert.deepEqual(plan.align, ['stable', 'trunk']);
  assert.deepEqual(await planRetirements({ ...input, remote: Object.fromEntries(Object.entries(input.remote).reverse()) }), plan);
});

test('snapshots refs and reviews before yielding to the ancestry resolver', async () => {
  const input = fixture();
  input.isAncestor = async sha => {
    input.remote['fix/squashed'] = unique;
    input.reviewedHeads[0].target = unique;
    input.reviewedHeads[0].evidence = 'changed after validation';
    return sha === integrated;
  };
  const plan = await planRetirements(input);
  assert.equal(plan.remote[1].sha, squashed);
  assert.equal(plan.remote[1].evidence, 'review/17: accepted squash diff');
});

test('requires boolean ancestry results and preserves inspection failure as a typed error', async () => {
  for (const value of [1, 'true', null, undefined]) {
    await assert.rejects(planRetirements({ ...fixture(), isAncestor: () => value }), code('ERR_ANCESTRY_CHECK'));
  }
  const cause = new Error('synthetic transport failure');
  await assert.rejects(planRetirements({ ...fixture(), isAncestor: () => { throw cause; } }), error => {
    assert.equal(error.code, 'ERR_ANCESTRY_CHECK'); assert.equal(error.cause, cause);
    assert.doesNotMatch(error.message, /synthetic transport failure/); return true;
  });
});

test('unsafe branch names are rejected before the ancestry callback', async () => {
  for (const name of ['feat/../hidden', 'feat/a.lock', 'feat/.hidden', 'feat/a b', 'feat/a\nb', 'feat/a:refs/heads/main', 'feat/a@{b', '-option', 'feat//a']) {
    const input = fixture(); input.remote[name] = target;
    input.isAncestor = () => assert.fail('malformed inputs must fail before ancestry');
    await assert.rejects(planRetirements(input), code('ERR_INPUT'));
  }
});

test('prototype names do not supply missing refs or inherit a review', async () => {
  const input = { repository, permanent: ['constructor', 'live'], remote: { live: target }, local: {}, isAncestor: () => true };
  await assert.rejects(planRetirements(input), code('ERR_PERMANENT_ALIGNMENT'));
  const nullRefs = Object.assign(Object.create(null), { constructor: target, live: target, 'feat/__proto__': target });
  const plan = await planRetirements({ ...input, remote: nullRefs });
  assert.equal(plan.remote[0].branch, 'feat/__proto__');
});

test('accessor properties are rejected without evaluating them', async () => {
  const input = fixture();
  Object.defineProperty(input.remote, 'feat/getter', { enumerable: true, get() { assert.fail('getter must not execute'); } });
  await assert.rejects(planRetirements(input), code('ERR_INPUT'));
});

test('rejects unsupported inputs, legacy review maps and ambiguous or empty evidence', async () => {
  const cases = [undefined, null, [], { ...fixture(), knownHeads: { 'fix/squashed': squashed } },
    ...[null, [], ['main', 'main'], Array(2)].map(permanent => ({ ...fixture(), permanent })),
    ...[null, [], ['feat'], ['feat/', 'feat/']].map(temporaryPrefixes => ({ ...fixture(), temporaryPrefixes })),
    { ...fixture(), reviewedHeads: null }, { ...fixture(), remote: [] }, { ...fixture(), objectFormat: 'sha512' },
    { ...fixture(), repository: ' ' }, { ...fixture(), isAncestor: undefined }];
  for (const input of cases) await assert.rejects(planRetirements(input), code('ERR_INPUT'));
  for (const evidence of ['', 'private\nvalue', 'x'.repeat(2049)]) {
    const input = fixture(); input.reviewedHeads[0].evidence = evidence;
    await assert.rejects(planRetirements(input), code('ERR_INPUT'));
  }
  const duplicate = fixture(); duplicate.reviewedHeads.push({ ...duplicate.reviewedHeads[0] });
  await assert.rejects(planRetirements(duplicate), code('ERR_INPUT'));
});

test('bounds oversized collections before invoking ancestry', async () => {
  const input = fixture(); input.reviewedHeads = Array(10001).fill(input.reviewedHeads[0]);
  await assert.rejects(planRetirements(input), code('ERR_INPUT'));
  const hugeRefs = Object.fromEntries(Array.from({ length: 10001 }, (_, i) => [`feat/b${i}`, target]));
  await assert.rejects(planRetirements({ ...fixture(), remote: hugeRefs }), code('ERR_INPUT'));
});

test('validates and plans explicitly selected SHA-256 repositories', async () => {
  const sha = 'a'.repeat(64), head = 'b'.repeat(64);
  const plan = await planRetirements({ repository, permanent: ['main', 'live'], objectFormat: 'sha256',
    remote: { main: sha, live: sha, 'feat/integrated': head }, local: {}, isAncestor: () => true });
  assert.equal(plan.objectFormat, 'sha256'); assert.equal(plan.remote[0].sha, head);
});

test('a single permanent branch plans integrated work and still refuses unreviewed work', async () => {
  const options = { repository, permanent: ['main'], remote: { main: target, 'feat/done': integrated },
    local: { main: target, 'feat/done': integrated }, isAncestor: () => true };
  const plan = await planRetirements(options);
  assert.equal(plan.remote[0].branch, 'feat/done'); assert.deepEqual(plan.align, []);
  await assert.rejects(planRetirements({ ...options, isAncestor: () => false }), code('ERR_UNREVIEWED_WORK'));
});
