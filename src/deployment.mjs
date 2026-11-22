import { fail } from './errors.mjs';
import { fields, branch, branchList, objectFormat, objectId } from './validation.mjs';

/** Validate source metadata only; no provider, credentials, deployment or CI query. */
export function assertDeploymentSource(input) {
  const options = fields(input, ['target', 'targets', 'sha', 'localBranch', 'status', 'ci', 'objectFormat'], 'Deployment options');
  const format = objectFormat(options.objectFormat);
  const target = branch(options.target, 'Deployment target');
  const targets = branchList(options.targets, 'Allowed deployment targets');
  const sha = objectId(options.sha, format);
  if (!targets.includes(target)) fail('ERR_DEPLOYMENT_TARGET', 'Choose an explicitly allowed deployment target.');
  if (options.status !== '') {
    fail('ERR_DIRTY_SOURCE', 'Deployment requires clean committed source.');
  }
  if (typeof options.localBranch !== 'string') fail('ERR_INPUT', 'Supply the local branch, or an empty string for detached CI.');
  if (options.localBranch !== '') branch(options.localBranch, 'Local branch');
  let sourceBranch = options.localBranch;
  if (options.ci !== undefined) {
    const ci = fields(options.ci, ['branch', 'sha'], 'CI identity');
    sourceBranch = branch(ci.branch, 'CI branch');
    if (objectId(ci.sha, format, 'CI commit ID') !== sha) fail('ERR_CI_IDENTITY', 'CI source must match the checkout commit.');
    if (options.localBranch && options.localBranch !== sourceBranch) fail('ERR_CI_IDENTITY', 'Attached local and CI branch identities must agree.');
  }
  if (sourceBranch !== target) fail('ERR_DEPLOYMENT_SOURCE', 'Deployment requires the selected target branch or matching detached CI identity.');
  return { target, sha };
}
