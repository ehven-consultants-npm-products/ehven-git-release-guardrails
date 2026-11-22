import type { ReviewedHead, RetirementPlan, ObjectFormat } from '../index.mjs';

export interface InspectionOptions {
  readonly cwd: string;
  readonly repository: string;
  readonly expectedRemoteUrls: readonly string[];
  readonly remote?: string;
  readonly integrationBranch: string;
  readonly permanent: readonly string[];
  readonly reviewedHeads?: readonly ReviewedHead[];
  readonly temporaryPrefixes?: readonly string[];
  /** Git inspection deadline in milliseconds; 1..30000, default 10000. */
  readonly timeoutMs?: number;
  /** Combined stdout/stderr bytes per command; 1024..16777216, default 4194304. */
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}
export interface InspectionResult {
  inspectionOnly: true;
  remoteFreshness: 'unverified-local-cache';
  networkAccess: false;
  refMutations: false;
  source: { root: string; branch: string; head: string; objectFormat: ObjectFormat; remote: string };
  transport: { fetchUrl: string; pushUrl: string; fetchRefspec: string };
  worktrees: { path: string; branch: string; head: string }[];
  plan: RetirementPlan;
}
export function inspectRetirements(options: InspectionOptions): Promise<InspectionResult>;
