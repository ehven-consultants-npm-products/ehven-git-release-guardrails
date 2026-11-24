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

export interface LiveInspectionOptions extends InspectionOptions {
  /** Optional Basic or Bearer header value sent only to this exact approved HTTPS endpoint. */
  readonly httpsAuthorization?: { readonly endpoint: string; readonly value: string };
}
export interface LiveInspectionResult extends Omit<InspectionResult, 'remoteFreshness' | 'networkAccess'> {
  remoteFreshness: 'matched-live-advertisement';
  networkAccess: true;
  observation: { checkedAt: string; fetchBranchCount: number; pushBranchCount: number; distinctEndpointsChecked: number };
}
export function validateLiveRetirement(options: LiveInspectionOptions): Promise<LiveInspectionResult>;

/** Declarative schemaVersion 1 data; paths/AbortSignal are supplied by the caller. */
export type RetirementConfig = Omit<InspectionOptions, 'cwd' | 'signal'>;
/** A regular, nonsymlink UTF-8 JSON file, at most 1 MiB; no executable config. */
export function readRetirementConfig(file: string, options?: { readonly signal?: AbortSignal }): Promise<RetirementConfig>;

export interface BackupOptions {
  readonly directory: string;
  /** Whole Git-operation deadline; 1..30000 milliseconds, default 30000. Native FS calls are not preempted. */
  readonly timeoutMs?: number;
  /** Bundle byte limit; 1024..1073741824, default 268435456. */
  readonly maxBackupBytes?: number;
  readonly signal?: AbortSignal;
}
export interface BackupResult {
  verified: true;
  repository: string;
  objectFormat: ObjectFormat;
  refCount: number;
  bundleSha256: string;
  bundleBytes: number;
  directory: string;
  networkAccess: false;
  sourceRefMutations: false;
}
export interface RestorationResult extends BackupResult { destination: string; }
export function createRetirementBackup(options: BackupOptions & { readonly inspection: Omit<InspectionOptions, 'signal'> }): Promise<BackupResult>;
export function verifyRetirementBackup(options: BackupOptions): Promise<BackupResult>;
export function restoreRetirementBackup(options: BackupOptions & { readonly destination: string }): Promise<RestorationResult>;
