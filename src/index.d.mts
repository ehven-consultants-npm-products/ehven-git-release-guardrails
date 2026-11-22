export type ObjectFormat = 'sha1' | 'sha256';
export interface ReviewedHead {
  readonly repository: string;
  readonly branch: string;
  readonly head: string;
  readonly target: string;
  /** Consumer-owned record/reference identifying an actual completed review. */
  readonly evidence: string;
}
export interface RetirementOptions {
  readonly repository: string;
  readonly permanent: readonly string[];
  readonly remote: Readonly<Record<string, string>>;
  readonly local: Readonly<Record<string, string>>;
  readonly reviewedHeads?: readonly ReviewedHead[];
  readonly temporaryPrefixes?: readonly string[];
  readonly objectFormat?: ObjectFormat;
  readonly isAncestor: (head: string, target: string) => boolean | Promise<boolean>;
}
export type RetirementEntry = { branch: string; sha: string } & (
  { basis: 'ancestry' } | { basis: 'reviewed-head'; evidence: string }
);
export interface RetirementPlan {
  repository: string;
  objectFormat: ObjectFormat;
  target: string;
  remote: RetirementEntry[];
  local: RetirementEntry[];
  align: string[];
}
export interface DeploymentSourceOptions {
  readonly target: string;
  readonly targets: readonly string[];
  readonly sha: string;
  /** An empty string indicates a detached checkout. */
  readonly localBranch: string;
  /** Exact clean porcelain output: an empty string. */
  readonly status: string;
  readonly ci?: { readonly branch: string; readonly sha: string };
  readonly objectFormat?: ObjectFormat;
}
export class GitReleaseGuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions);
}
export const DEFAULT_TEMPORARY_PREFIXES: readonly string[];
export function planRetirements(options: RetirementOptions): Promise<RetirementPlan>;
export function assertDeploymentSource(options: DeploymentSourceOptions): { target: string; sha: string };
export interface RemoteDestinationOptions {
  readonly expectedRemoteUrls: readonly string[];
  readonly fetchUrls: readonly string[];
  readonly pushUrls: readonly string[];
}
export function normalizeRemoteUrl(url: string): string;
export function assertRemoteDestinations(options: RemoteDestinationOptions): { fetchUrl: string; pushUrl: string };
