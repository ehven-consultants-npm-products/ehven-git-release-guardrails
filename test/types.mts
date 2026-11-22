import { planRetirements, assertDeploymentSource, type RetirementOptions, type ReviewedHead } from '../src/index.mjs';

const input: RetirementOptions = {
  repository: 'example.test/team/project', permanent: ['main', 'live'], remote: {}, local: {},
  isAncestor: async () => false,
};
const review: ReviewedHead = { repository: input.repository, branch: 'fix/task', head: 'a', target: 'b', evidence: 'review/1' };
const plan = await planRetirements({ ...input, reviewedHeads: [review] });
for (const entry of plan.remote) {
  if (entry.basis === 'reviewed-head') entry.evidence.toUpperCase();
}
assertDeploymentSource({ target: 'live', targets: ['live'], sha: 'a', localBranch: 'live', status: '' });
// @ts-expect-error The unsafe legacy review map is deliberately unsupported.
planRetirements({ ...input, knownHeads: { 'fix/task': 'a' } });
// @ts-expect-error A review must identify the accepted integration target.
const incomplete: ReviewedHead = { repository: input.repository, branch: 'fix/task', head: 'a', evidence: 'review/1' };
// @ts-expect-error The ancestry resolver must return a boolean or Promise<boolean>.
planRetirements({ ...input, isAncestor: () => 'yes' });
void incomplete;
