# @ehven/git-release-guardrails

Portable guards for retiring integrated Git branches and checking deployment
source identity. MIT licensed; zero npm runtime dependencies.

## Development status

This private development candidate implements portable guards and bounded,
local Git inspection through an optional Node entrypoint. The first complete
release will also include a branch-retirement CLI. That CLI, network transport,
backup/restore, guarded mutations/recovery and the optional Cloudflare deployment
adapter are not yet available in this candidate.

The development version is not published to npm. Do not replace an existing
site integration with this partial candidate. Current verification uses Linux,
Node 24.22.3 and Git 2.56.1; the release support matrix remains to be established.

## Portable API

The intended ESM entrypoint exports `planRetirements`,
`assertDeploymentSource`, `GitReleaseGuardError`, `DEFAULT_TEMPORARY_PREFIXES`,
`normalizeRemoteUrl` and `assertRemoteDestinations`. Adjacent TypeScript declarations describe the API.
Importing this entrypoint requires no Git executable, credentials, network,
filesystem access, Cloudflare account, Wrangler or pnpm. No process environment
is consulted by these guards.

### planRetirements(options)

Returns a Promise for a complete retirement plan, or rejects the entire plan.
The function does not execute Git or change refs. Its snapshots and ancestry
resolver must come from a trusted caller. It does not prove that arbitrary
supplied commit IDs exist or that a review actually occurred.

| Option | Contract |
| --- | --- |
| `repository` | Bounded nonempty consumer-owned repository identity. Use a canonical, credential-free value. Review matching uses exact string equality. |
| `permanent` | Two to 100 distinct permanent short branch names. All corresponding remote heads must exist and identify the same target commit. |
| `remote`, `local` | Plain objects mapping short branch names to full commit IDs; null-prototype data objects are supported. At most 10,000 entries in each map. No accessor properties. |
| `isAncestor(head, target)` | Required trusted resolver returning a boolean or Promise of a boolean. `true` means ancestry was established; `false` means it was not. A thrown/rejected error stops the plan. Bound transport time and cancellation in the resolver. |
| `objectFormat` | `sha1` by default; explicitly select `sha256` for that object format. Mixed formats, abbreviated IDs, uppercase IDs and all-zero IDs are rejected. |
| `temporaryPrefixes` | Distinct literal prefixes ending in `/`. Default: `docs/`, `feat/`, `fix/`, `refactor/`, `chore/`. Nested branch names are supported. This is data, not a regex or callback. |
| `reviewedHeads` | Optional array of at most 10,000 structured review records, described below. Defaults to an empty array. Explicit `null` is invalid. |

Unrecognized fields fail rather than silently changing behavior. Names and
identity text are bounded to 1,024 characters. Branches must be supported short
Git branch names without whitespace, controls, option prefixes, traversal-like
components or Git-reserved sequences. This contract is intentionally narrower
than accepting every possible ref name.

Each squash-review record contains exactly:

```js
{
  repository: 'example.test/team/project',
  branch: 'fix/reviewed-change',
  head: reviewedTemporaryCommit,
  target: acceptedIntegrationCommit,
  evidence: 'review-record/42'
}
```

All five fields are required. `evidence` is nonempty text up to 2,048 characters,
not an executable callback or a URL the package fetches. Duplicate records for
the same repository/branch/head/target are rejected as ambiguous. A review for
another repository, branch, head or target cannot authorize retirement. An older
review may remain in the array but grants no authority to a different tuple.

A review is an assertion supplied by a trusted integrator. The package neither
authenticates the reviewer nor independently verifies equivalent changes. A
reviewed head is never permission to overwrite a divergent permanent branch.

The returned data has this shape:

```js
{
  repository, objectFormat, target,
  remote: [{ branch, sha, basis: 'ancestry' }],
  local: [{ branch, sha, basis: 'reviewed-head', evidence }],
  align: ['local-permanent-branch-needing-alignment']
}
```

Each temporary entry has its actual proof basis. Arrays are sorted by JavaScript
string order, independently of input property order and system locale. Missing
local permanent branches appear in `align`; existing local permanent branches
with unique history stop the plan. Unknown nonpermanent branches stop the plan,
even when they point to the target. Plan inputs are copied and validated before
the first ancestry callback; the original inputs are not mutated.

This is a snapshot plan, not an execution authorization token. A future executor
must re-inspect and validate relevant live state, destinations, worktrees and
review evidence before consequential operations. It cannot assume the plan
remains current or that remote and local mutations share a transaction.

### assertDeploymentSource(options)

Checks an explicit allowed target, full commit ID, clean source and local/CI
branch identity. Returns `{ target, sha }`; it performs no deployment.

- `targets`: one to 100 distinct allowed short branch names.
- `target`: one of those names.
- `sha`: full nonzero lowercase ID in `objectFormat` (`sha1` by default).
- `status`: exactly `''`, representing clean porcelain output. Include
  untracked files when collecting actual Git status in a caller.
- `localBranch`: a short branch name; use `''` for detached CI only.
- `ci`: optional `{ branch, sha }` from a trusted caller. Its commit must match
  `sha`. An attached local branch must agree with the CI branch. A detached
  checkout requires matching CI metadata.

Plain metadata can be fabricated by a caller. Passing this guard does not prove
remote branch state, successful CI, human approval, the identity of build output
or the revision currently live. Optional Cloudflare behavior will remain an
explicit adapter, independent of this portable entrypoint.

### Errors

All guard failures use `GitReleaseGuardError` with a stable `code`:

| Code | Meaning |
| --- | --- |
| `ERR_INPUT` | Missing, malformed, unsupported, oversized or ambiguous input. |
| `ERR_PERMANENT_ALIGNMENT` | Remote permanent branches are missing or divergent. |
| `ERR_UNKNOWN_BRANCH` | A nonpermanent branch is outside the configured temporary prefixes. |
| `ERR_LOCAL_UNMERGED` | A local permanent branch has unique history. |
| `ERR_UNREVIEWED_WORK` | A temporary head lacks ancestry or an exact applicable review. |
| `ERR_ANCESTRY_CHECK` | Ancestry inspection failed or returned a nonboolean. |
| `ERR_DEPLOYMENT_TARGET` | The selected target is not allowed. |
| `ERR_DIRTY_SOURCE` | Clean source was not established. |
| `ERR_CI_IDENTITY` | Supplied CI identity conflicts with checkout identity. |
| `ERR_DEPLOYMENT_SOURCE` | The branch does not match the target. |

Messages omit input values. An ancestry failure preserves the original exception
as `cause` for trusted debugging; do not blindly log that cause when it may
contain transport or credential details. Review references and repository IDs
in returned plans remain consumer-controlled data.

## Migration from the local candidate

- Add explicit `repository` to planner input.
- Replace the old `knownHeads: { branch: sha }` map with `reviewedHeads` records.
  Re-review old squash exceptions against the exact accepted target; do not
  mechanically stamp historical entries with the current target.
- The old `knownHeads` option is intentionally rejected.
- Use configured literal prefixes when the default temporary naming convention
  does not fit. Unknown work continues to stop the plan.
- Expect proof metadata and stable sorted arrays in returned plans.
- Supply exact empty porcelain status for deployment checks. Attached local/CI
  conflicts are rejected; trusted detached CI remains supported.
- Defer site replacement until the complete CLI and recovery behavior have been
  verified and the actual package has been deliberately adopted.

## Remote endpoint guard

`assertRemoteDestinations({ expectedRemoteUrls, fetchUrls, pushUrls })` checks the
effective fetch and push endpoints independently. Supply one to eight deliberately
approved HTTPS/SSH URLs; the configured effective fetch and push must each contain
exactly one approved endpoint. Multiple actual destinations are refused.

`normalizeRemoteUrl(url)` canonicalizes equivalent syntax: hostname case, default
ports, and `git@host:path` versus `ssh://git@host/path`. It does not equate HTTPS
with SSH, remove `.git`, fold path case or assume different paths serve the same
repository. Declare each reviewed transport endpoint explicitly. Credential-bearing
HTTPS, SSH passwords, query/fragment URLs, ambiguous encoded paths and local/custom
transports are rejected without echoing their contents.

The consumer owns the relationship between its opaque repository identity, review
records and approved endpoint list. URL matching does not authenticate a server,
resolve SSH host aliases or verify who controls a hostname.

## Optional Node inspection entrypoint

```js
import { inspectRetirements } from '@ehven/git-release-guardrails/node';

const inspection = await inspectRetirements({
  cwd: '/absolute/path/to/repository-root',
  repository: 'example.test/team/project',
  expectedRemoteUrls: [
    'https://example.test/team/project.git',
    'git@example.test:team/project.git',
  ],
  remote: 'origin',
  integrationBranch: 'main',
  permanent: ['main', 'preview', 'live'],
  reviewedHeads: [],
});
```

This explicitly selected API requires Git. The root portable entrypoint does
not import it. Current executable verification is Linux/Node 24/Git 2.56.1;
additional operating systems and minimum Git versions remain release gates.

The inspector runs from a real repository root with an attached integration
branch and clean tracked/untracked source. It requires full local history, no
replacement refs/grafts/promisor state, and exactly one working tree. Linked,
detached, locked or prunable extra worktrees are refused for now. Preserve that
work; the inspector never removes worktrees. Executable content-filter configuration
is refused before status inspection, even if the current files do not use it.

Effective URLs are read through Git, including `insteadOf`/`pushInsteadOf`
rewrites. Require one complete branch fetch refspec such as
`+refs/heads/*:refs/remotes/origin/*`; filtered/negative/additional refspecs are
refused. Mirror, implicit push-refspec and follow-tags configuration is also
refused. Remote names use a conservative ASCII form, up to 64 characters.

Local and remote-tracking heads must align as required by the planner. The
inspector repeats source/ref/worktree/transport reads and refuses observed
changes during inspection. This is not an atomic lock or execution permit;
future apply operations must revalidate live state under their own controls.

The result includes `source`, `transport`, `worktrees` and `plan`, plus:

```js
{
  inspectionOnly: true,
  remoteFreshness: 'unverified-local-cache',
  networkAccess: false,
  refMutations: false
}
```

No fetch, remote query, push, pruning, deployment or ref update is performed.
Remote-tracking data may be stale. Refreshing it safely is a separate future
transport step; do not interpret a successful inspection as live remote proof.

Git commands use no shell, noninteractive input, optional locks disabled and
network protocols/lazy object fetching disabled. Filesystem-monitor hooks are
disabled; subprocess credentials and repository/environment overrides are not
forwarded. Git configuration locations are retained so actual endpoint rewrites
are visible. Use a trusted local repository, Git executable and configuration:
this is not a sandbox for arbitrary Git installations or filesystem mounts.

`timeoutMs` bounds the Git inspection phase and each command (default 10,000;
allowed 1..30,000). An optional `AbortSignal` cancels it. `maxOutputBytes` bounds
combined stdout/stderr per command (default 4 MiB; allowed 1 KiB..16 MiB). UTF-8
output is required. Command output and credential-bearing URLs are not copied
into errors. Native filesystem lookups are not cancelled by this Git-process
deadline; use trusted local filesystem locations.

Additional stable error codes include `ERR_REMOTE_URL`, `ERR_REMOTE_DESTINATION`,
`ERR_REPOSITORY_PATH`, `ERR_REPOSITORY_ROOT`, `ERR_SHALLOW_HISTORY`,
`ERR_REPLACED_HISTORY`, `ERR_PARTIAL_HISTORY`, `ERR_EXTERNAL_FILTER`,
`ERR_FETCH_REFSPEC`, `ERR_PUSH_CONFIGURATION`, `ERR_SOURCE_BRANCH`,
`ERR_SOURCE_ALIGNMENT`, `ERR_DETACHED_SOURCE`, `ERR_SYMBOLIC_REF`,
`ERR_WORKTREE`, `ERR_INSPECTION_CHANGED`, `ERR_INSPECTION_FS`, `ERR_GIT_PARSE`,
`ERR_GIT_START`, `ERR_GIT_COMMAND`, `ERR_GIT_ENCODING`, `ERR_GIT_OUTPUT_LIMIT`,
`ERR_GIT_TIMEOUT` and `ERR_ABORTED`. Inspect and preserve source on any refusal;
do not bypass it with forced cleanup.

## Development verification

`npm test` runs portable contract tests plus disposable local Git-history fixtures.
Fixtures cover ancestral and squashed work, changed target, alternate branches
and both SHA-1/SHA-256 histories. They do not contact a remote or delete live refs.
Synthetic fixtures are not a second real consumer or a full security assessment.
