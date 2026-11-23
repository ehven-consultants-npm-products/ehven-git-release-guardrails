import { planRetirements, assertDeploymentSource, type RetirementOptions, type ReviewedHead } from '../src/index.mjs';
import { inspectRetirements, type InspectionOptions } from '../src/node/index.mjs';

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
const inspection: InspectionOptions = { cwd: '/project', repository: input.repository, expectedRemoteUrls: ['https://example.test/team/project.git'], integrationBranch: 'main', permanent: ['main', 'live'] };
const inspected = await inspectRetirements(inspection);
const localOnly: 'unverified-local-cache' = inspected.remoteFreshness;
void localOnly;
// @ts-expect-error The inspector accepts endpoint data, not an arbitrary command runner.
inspectRetirements({ ...inspection, execute: () => true });

import { readRetirementConfig, type RetirementConfig } from '../src/node/index.mjs';
const configuration: RetirementConfig = await readRetirementConfig('/project/config.json', { signal: new AbortController().signal });
inspectRetirements({ ...configuration, cwd: '/project' });
// @ts-expect-error Executable configuration is unsupported.
readRetirementConfig(() => ({ repository: 'anything' }));
// @ts-expect-error Repository paths come from the invoking caller.
const embeddedPath: RetirementConfig = { ...configuration, cwd: '/project' };
void embeddedPath;
