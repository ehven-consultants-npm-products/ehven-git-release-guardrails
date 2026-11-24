# @ehven/git-release-guardrails

Portable guards for retiring integrated Git branches and checking deployment
source identity. MIT licensed; zero npm runtime dependencies.

## Development status

This private development candidate implements portable guards and bounded,
local Git inspection through an optional Node entrypoint, and a retirement CLI
with local and live read-only preview plus verified backup and restoration. The
remaining execution work is guarded branch retirement, journaled recovery from
partial completion, and any optional Cloudflare deployment support.

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
| `permanent` | One to 100 distinct permanent short branch names. All corresponding remote heads must exist and identify the same target commit. |
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
step provided by the opt-in live preview below.

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
and both SHA-1/SHA-256 histories. Live preview tests use disposable remotes.
Synthetic fixtures are not a second real consumer or a full security assessment.

## Retirement CLI and configuration

The installed executable is `ehven-git-release-guardrails`. This development
candidate supports preview, backup, verify-backup and restore-backup. Preview supports an explicit read-only live comparison.

```sh
ehven-git-release-guardrails --help
ehven-git-release-guardrails --version
ehven-git-release-guardrails preview --config ../retirement.json --cwd /path/to/repository
ehven-git-release-guardrails preview --config ../retirement.json --cwd /path/to/repository --json
```

Supply a deliberate schemaVersion 1 JSON file:

```json
{
  "schemaVersion": 1,
  "repository": "example.test/team/project",
  "expectedRemoteUrls": ["https://example.test/team/project.git"],
  "remote": "origin",
  "integrationBranch": "main",
  "permanent": ["main"],
  "temporaryPrefixes": ["docs/", "feat/", "fix/", "refactor/", "chore/"],
  "reviewedHeads": [],
  "timeoutMs": 10000,
  "maxOutputBytes": 4194304
}
```

The integration branch must be permanent. A single permanent branch is supported;
multiple permanent remote branches must all identify the same accepted commit.
Remote, temporary prefixes, reviews and inspection limits use the defaults and
contracts described above. Unknown fields, duplicate JSON keys (including escaped
aliases), invalid reviews and unsupported schema versions are refused. Store
only credential-free endpoints and deliberately approved review records.

Both paths resolve from the invocation directory. `--cwd` defaults to that
directory; the config file's directory does not change the selected repository.
Keep an external config outside the working tree, or commit/ignore it deliberately
so the source passes clean-state inspection. The CLI never writes a config file.

Configuration is UTF-8 JSON data only, at most 1 MiB and 32 nesting levels. No
modules, shell commands, environment interpolation or automatic config discovery
are supported. The loader requires a regular file and refuses a symlink at the
final path component, directories and FIFOs. It checks observed file metadata
before/after reading. Parent directories/filesystems and concurrent writers must
be trusted; these checks are not a filesystem sandbox or an atomic path lock.
Platforms without the required file-open protections are refused. Native file
operations are not covered by the Git-process deadline.

`readRetirementConfig(file, { signal? })` is also exported from the optional Node
entrypoint. It returns inspection options without `cwd` or `signal`; supply those
explicitly to `inspectRetirements`. It never runs Git. Review commit formats are
checked internally for consistency and then against the actual repository during
inspection. Cancellation is checked before and between file reads.

With `--json`, success is one JSON object on stdout:

```js
{ schemaVersion: 1, ok: true, command: 'preview', result: inspection }
```

Refusals leave stdout empty and write one JSON object on stderr:

```js
{ schemaVersion: 1, ok: false, error: { code, message } }
```

Exit codes: 0 for success/help/version, 1 for a refused or failed command,
2 for unsupported/repeated/missing CLI arguments, 130 for handled SIGINT and
143 for handled SIGTERM. Help/version do not require Git or a config. Unknown
commands and apply/fetch/deployment/in-place-recovery flags are refused. Human output
lists temporary branches and proof bases, plus permanent alignment candidates.
Returned repository data may be sensitive; choose where to retain CLI output.

Configuration adds `ERR_CONFIG_FILE`, `ERR_CONFIG_JSON`, `ERR_CONFIG_SCHEMA`,
`ERR_CONFIG_LIMIT`, `ERR_CONFIG_CHANGED`; the CLI adds `ERR_CLI_USAGE` and
`ERR_CLI_FAILURE`. Raw parser/subprocess input is not echoed in refusal messages.
On POSIX, cancellation/deadlines terminate the subprocess group owned by each
command, including helpers sharing its output pipes. This is not a control for
arbitrary daemonized processes. Current executable verification remains Linux.

## Live retirement preview

```sh
ehven-git-release-guardrails preview --config ../retirement.json --cwd /path/to/repository --live --json
```

Use the package's local preview first. Live mode applies the same source,
worktree, review, refspec and endpoint checks. It runs read-only `git ls-remote`
against each distinct effective fetch and push endpoint, then rechecks the local
snapshot. Each endpoint must advertise exactly the branch names and commit IDs
in the local remote-tracking cache. New, missing and moved heads stop the preview.
No tags are compared. A push endpoint must support read access for this check.

A success reports `remoteFreshness: 'matched-live-advertisement'` and an
`observation` with its completion timestamp, the branch count for each endpoint
and the number of distinct endpoints queried. This is a point-in-time comparison
of visible advertisements. Server permissions or hidden-ref policy can limit
visibility. Endpoints are read separately and may change during or after the
check. A matching advertisement does not prove push access or authorize a
mutation. An executor must obtain its own fresh state and atomic checks.

Live mode supports explicit HTTPS and direct OpenSSH with simple ASCII host and
repository path syntax. For SSH, use the same URL form in the allowlist and Git
configuration. SCP-style relative paths and `ssh://` absolute paths are distinct.
SSH requires established host trust and a default identity or local agent. The
query uses batch mode without SSH config aliases, forwarding or host-key updates.
HTTPS uses verified TLS and disables redirects. Both transports run with isolated
Git configuration, so query-time URL rewrites and credential helpers are bypassed.

For an authenticated HTTPS repository, load a complete `Basic ...` or `Bearer
...` authorization value into an environment variable through your secret
manager or CI configuration. Pass its name with `--https-auth-env` and the
matching approved URL with `--https-auth-endpoint`. Never put the header value in
command arguments or the JSON configuration. Only the child querying that exact
HTTPS endpoint receives the header. The Node API accepts `httpsAuthorization:
{ endpoint, value }` on `validateLiveRetirement(options)` from the Node subpath.
Both interfaces use the same source policy and bounded Git deadline.

A stale preview reports added, missing and moved counts. Inspect and refresh
tracking refs using your normal Git workflow before trying again. This command
does not fetch objects, prune tracking refs, push, or delete branches.

## Verified local backups and fresh bare recovery

```sh
ehven-git-release-guardrails backup --config ../retirement.json --cwd /path/to/repository --directory /private/backups/new-snapshot --json
ehven-git-release-guardrails verify-backup --directory /private/backups/new-snapshot --json
ehven-git-release-guardrails restore-backup --directory /private/backups/new-snapshot --destination /private/recovery/new.git --json
```

The optional Node entrypoint exports the matching functions:

```js
const backup = await createRetirementBackup({
  inspection: { ...config, cwd: '/path/to/repository' },
  directory: '/private/backups/new-snapshot',
});
await verifyRetirementBackup({ directory: backup.directory });
const recovery = await restoreRetirementBackup({
  directory: backup.directory,
  destination: '/private/recovery/new.git',
});
```

Import these functions from `@ehven/git-release-guardrails/node`. Creation requires
an eligible retirement inspection, including clean/full history and the current
worktree, endpoint, ancestry/review and alignment gates. It repeats inspection and
all-ref snapshots after proving restoration. These are local-cache checks, with
no live remote proof and no original ref mutation.

Creation requires a new directory outside the source working tree and Git common
directory. Its parent must already exist. Broken refs and incomplete reachable
history prevent backup creation. It writes a self-contained
`repository.bundle`, then records `manifest.json` only after an actual isolated
bare clone, exact refs/object-format/HEAD comparison and `git fsck --full --strict`
succeed. The complete fsynced manifest is published exclusively with a hard link;
no existing manifest is replaced. Supported filesystem hard links are required.
The two final files are private (requested mode 0600, directory 0700), subject to
a possibly stricter caller umask. Temporary proof repositories are removed.

The bundle contains objects reachable from all recorded refs and HEAD, including
annotated tags and reviewed squash heads. The manifest records full ref names,
object IDs, symbolic aliases and their immediate targets, original attached branch, object format, byte count
and SHA256 digest. Both SHA-1 and SHA-256 repositories are covered by executable
fixtures. Ref/object-format/HEAD preservation was verified after removing the
original fixture repository.

This is **Git history recovery**, with a deliberately bounded scope:

- It excludes working files, index state, repository configuration, credentials,
  hooks, reflogs and unreachable objects. Git LFS content and submodule working
  repositories are not fetched or backed up; committed pointer/gitlink objects
  remain Git objects in the bundle. Preserve those external assets separately.
- Recovery creates a new **bare repository** outside existing Git working trees
  and metadata directories. It does not check out a working
  tree, configure the original remote, reconnect worktrees or change an existing
  repository. Inspect recovered history before separately cloning/using it.
- A backup can contain private historical data. Restrict its storage and access.
  Digests detect mismatched bytes; they do not authenticate an unknown author or
  protect against someone replacing both manifest and bundle consistently.

Verification repeats isolated restoration and fsck; a matching digest alone is
insufficient. Incremental bundles with prerequisites, filtered/unknown bundle
capabilities, extra/missing advertised refs, malformed manifests, duplicate JSON
keys, changed inputs and invalid packs are refused. Manifest/header input is
bounded to 4 MiB; at most 10,000 refs and 100 symbolic aliases are supported.

Restoration first stages the exact regular-file bytes it verifies into a private
temporary directory. Git clones only that staged file, with global/system Git
configuration disabled, empty templates and network protocols disabled except
local file access for this specific clone. It removes the clone's temporary
transport configuration, restores recorded aliases/HEAD, and verifies the result.
Configured URL rewrites and templates cannot redirect this recovery clone.
Original backup files and source refs are left unchanged.

`timeoutMs` is 1..30,000 milliseconds (default 30,000) for the complete Git backup,
verify or restore operation. Native filesystem calls are not preempted; cancellation
is checked between reads/writes/commands. `maxBackupBytes` is 1 KiB..1 GiB (default
256 MiB). Creation/copying stream bundle data rather than buffering the whole
pack; Git's internal memory use is not bounded by this byte limit. The CLI exposes
`--timeout-ms` and `--max-backup-bytes` on these three commands. These are separate
from the source inspection's per-command output limits.

A refusal/interruption can leave the new backup directory incomplete, or leave a
new partial recovery repository. Preserve it for inspection. Retry only with a
new destination; existing paths are never overwritten or automatically removed.
A very late interruption may leave a complete backup; run `verify-backup` before
relying on it. Manifest presence is not a substitute for verification. This is
not a power-loss durability certification or a journaled live-ref recovery system.

Paths, parent filesystems/writers, the installed Git executable and source Git
configuration must be trusted. Final input symlinks, directories/FIFOs used as
files, and a symlinked backup input directory are refused. Parent symlinks are
resolved deliberately, not sandboxed. Observed source/input changes are refused;
checks do not lock out arbitrary concurrent writers or detect every transient
change. Always revalidate live refs before any future apply operation.

Current executable verification is Linux/Node 24/Git 2.56.1. Unsupported POSIX
protections are refused; Windows is not supported for backup/recovery. Uncertain
worktree metadata, including separate-Git-dir layouts whose worktree listing
conflicts with the supplied source root, remains refused by inspection.

Backup results include `verified: true`, `repository`, `objectFormat`, `refCount`,
`bundleSha256`, `bundleBytes`, absolute `directory`, `networkAccess: false` and
`sourceRefMutations: false`; restore additionally returns absolute `destination`.
CLI JSON uses the same success/error envelope as preview with its actual command
name. Stable additional errors are `ERR_BACKUP_PLATFORM`, `ERR_BACKUP_PATH`,
`ERR_BACKUP_DESTINATION`, `ERR_BACKUP_FILE`, `ERR_BACKUP_LIMIT`,
`ERR_BACKUP_CHANGED`, `ERR_BACKUP_REFS`, `ERR_BACKUP_MANIFEST`,
`ERR_BACKUP_BUNDLE`, `ERR_BACKUP_INTEGRITY`, `ERR_BACKUP_RESTORE` and
`ERR_BACKUP_IO`, alongside existing input/Git/cancellation codes.
