import { GitReleaseGuardError, fail } from './errors.mjs';
import { LIMITS, fields, list, text, branch, branchList, objectFormat, objectId, refMap } from './validation.mjs';

export const DEFAULT_TEMPORARY_PREFIXES = Object.freeze(['docs/', 'feat/', 'fix/', 'refactor/', 'chore/']);

/**
 * Plan retirement from complete caller-supplied snapshots. No Git or filesystem I/O.
 * A review is a trusted caller assertion, not authenticated approval or merge proof.
 */
export async function planRetirements(input) {
  const options = fields(input, ['repository', 'permanent', 'remote', 'local', 'reviewedHeads', 'temporaryPrefixes', 'objectFormat', 'isAncestor'], 'Planner options');
  const repository = text(options.repository, 'Repository identity');
  const format = objectFormat(options.objectFormat);
  const permanent = branchList(options.permanent, 'Permanent branches');
  const remote = refMap(options.remote, format, 'Remote refs');
  const local = refMap(options.local, format, 'Local refs');
  const prefixes = list(options.temporaryPrefixes === undefined ? DEFAULT_TEMPORARY_PREFIXES : options.temporaryPrefixes, 'Temporary prefixes').map(prefix => {
    text(prefix, 'Temporary prefix');
    if (!prefix.endsWith('/')) fail('ERR_INPUT', 'Each temporary prefix must end with a slash.');
    branch(prefix.slice(0, -1), 'Temporary prefix');
    return prefix;
  });
  if (!prefixes.length || new Set(prefixes).size !== prefixes.length) fail('ERR_INPUT', 'Supply distinct temporary prefixes.');
  if (typeof options.isAncestor !== 'function') fail('ERR_INPUT', 'Supply an ancestry resolver.');
  const isAncestor = options.isAncestor;
  const reviews = list(options.reviewedHeads === undefined ? [] : options.reviewedHeads, 'Reviewed heads', LIMITS.reviews).map(item => {
    const review = fields(item, ['repository', 'branch', 'head', 'target', 'evidence'], 'Reviewed head');
    return {
      repository: text(review.repository, 'Reviewed repository'),
      branch: branch(review.branch, 'Reviewed branch'),
      head: objectId(review.head, format, 'Reviewed head'),
      target: objectId(review.target, format, 'Reviewed target'),
      evidence: text(review.evidence, 'Review evidence reference', LIMITS.evidence),
    };
  });
  const reviewIndex = new Map();
  const key = (repo, name, head, target) => JSON.stringify([repo, name, head, target]);
  for (const review of reviews) {
    const identity = key(review.repository, review.branch, review.head, review.target);
    if (reviewIndex.has(identity)) fail('ERR_INPUT', 'Duplicate reviewed-head identities are ambiguous.');
    reviewIndex.set(identity, review);
  }
  const target = remote[permanent[0]];
  if (!target || permanent.some(name => !Object.hasOwn(remote, name) || remote[name] !== target)) {
    fail('ERR_PERMANENT_ALIGNMENT', 'Permanent remote branches must identify the same commit before retirement.');
  }
  const permanentSet = new Set(permanent);
  // Validate the entire snapshot before executing even the ancestry callback.
  for (const refs of [remote, local]) {
    if (Object.keys(refs).some(name => !permanentSet.has(name) && !prefixes.some(prefix => name.startsWith(prefix)))) {
      fail('ERR_UNKNOWN_BRANCH', 'An unrecognized branch requires review before cleanup.');
    }
  }
  const ancestry = new Map();
  async function ancestor(head) {
    if (head === target) return true;
    if (!ancestry.has(head)) {
      let result;
      try { result = await isAncestor(head, target); }
      catch (cause) { throw new GitReleaseGuardError('ERR_ANCESTRY_CHECK', 'Ancestry inspection failed; retirement refused.', { cause }); }
      if (typeof result !== 'boolean') fail('ERR_ANCESTRY_CHECK', 'The ancestry resolver must return a boolean.');
      ancestry.set(head, result);
    }
    return ancestry.get(head);
  }
  const plan = {
    repository, objectFormat: format, target, remote: [], local: [],
    align: permanent.filter(name => local[name] !== target).sort(),
  };
  for (const name of permanent) {
    if (Object.hasOwn(local, name) && !await ancestor(local[name])) {
      fail('ERR_LOCAL_UNMERGED', 'A local permanent branch has unique history; preserve and reconcile it first.');
    }
  }
  for (const [scope, refs] of [['remote', remote], ['local', local]]) {
    for (const name of Object.keys(refs).sort()) {
      if (permanentSet.has(name)) continue;
      const sha = refs[name];
      if (await ancestor(sha)) {
        plan[scope].push({ branch: name, sha, basis: 'ancestry' });
      } else {
        const review = reviewIndex.get(key(repository, name, sha, target));
        if (!review) fail('ERR_UNREVIEWED_WORK', 'Temporary work lacks ancestry or an exact repository/head/target review.');
        plan[scope].push({ branch: name, sha, basis: 'reviewed-head', evidence: review.evidence });
      }
    }
  }
  return plan;
}
