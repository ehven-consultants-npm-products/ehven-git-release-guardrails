#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import metadata from '../package.json' with { type: 'json' };
import { inspectRetirements, validateLiveRetirement, readRetirementConfig, createRetirementBackup, verifyRetirementBackup, restoreRetirementBackup, applyRetirement, recoverRetirement } from '../src/node/index.mjs';
import { GitReleaseGuardError } from '../src/errors.mjs';

const commands = ['preview', 'backup', 'verify-backup', 'restore-backup', 'apply', 'recover'];
const help = `Usage: ehven-git-release-guardrails preview --config FILE [--cwd ROOT] [--live] [--json]
       ehven-git-release-guardrails backup --config FILE --directory NEW [--cwd ROOT] [--json]
       ehven-git-release-guardrails verify-backup --directory DIR [--json]
       ehven-git-release-guardrails restore-backup --directory DIR --destination NEW [--json]
       ehven-git-release-guardrails apply --config FILE --expect-plan ID --directory NEW [--cwd ROOT] [--json]
       ehven-git-release-guardrails recover --config FILE --expect-plan ID --directory DIR [--cwd ROOT] [--json]
       ehven-git-release-guardrails --help
       ehven-git-release-guardrails --version

Preview integrated temporary branches using local Git and cached remote refs.
Backup creates a new private directory outside source; it verifies isolated bare
restoration before writing its completion manifest. Verify-backup repeats that
proof. Restore-backup creates a fresh bare repository, never an existing target.
Preview uses the local cache by default. --live compares that cache with the
branches advertised by the approved endpoints and prints a point-in-time plan ID.
Apply requires that reviewed ID and writes a verified backup and journal before
changing refs. Recover continues the exact recorded plan after an interruption.

--config FILE          SchemaVersion 1 regular JSON file (at most 1 MiB).
--cwd ROOT             Source root for preview/backup; default invocation directory.
--live                 Request read-only live remote validation.
--https-auth-endpoint URL  Exact approved HTTPS endpoint for authorization.
--https-auth-env NAME      Environment variable containing Basic or Bearer value.
--expect-plan ID           Full plan ID from the reviewed live preview.
--directory DIR        New backup output or existing backup input, by command.
--destination NEW      New bare recovery directory for restore-backup.
--timeout-ms N         Backup stage deadline, 1..30000; default 30000.
--max-backup-bytes N   Bundle limit, 1024..1073741824; default 268435456.
--json                 JSON success on stdout; JSON refusals on stderr.

Paths resolve from the invocation directory. Configuration is data only. Backup
preserves ref-reachable Git history, not working files, configuration, reflogs or
unreachable objects. Keep backup history private. Parent filesystems/writers are
trusted; native filesystem calls are not preempted by the Git-process deadline.
The apply/recover commands can delete committed branches. See the README for
the separate remote and local transaction guarantees and recovery procedure.
`;

const args = process.argv.slice(2);
let json = args.includes('--json');
const controller = new AbortController();
let interrupted;
const onInterrupt = signal => { interrupted = signal; controller.abort(); };
const onSigint = () => onInterrupt('SIGINT'), onSigterm = () => onInterrupt('SIGTERM');
process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);
const usage = () => { throw new GitReleaseGuardError('ERR_CLI_USAGE', 'Select a supported command with its required arguments, or use --help.'); };
try {
  let parsed;
  try {
    parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
      config: { type: 'string' }, cwd: { type: 'string' }, json: { type: 'boolean' },
      help: { type: 'boolean' }, version: { type: 'boolean' }, directory: { type: 'string' },
      destination: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'max-backup-bytes': { type: 'string' },
      live: { type: 'boolean' }, 'https-auth-endpoint': { type: 'string' }, 'https-auth-env': { type: 'string' },
      'expect-plan': { type: 'string' },
    } });
    const names = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
    if (new Set(names).size !== names.length) throw new Error();
  } catch { throw new GitReleaseGuardError('ERR_CLI_USAGE', 'Unsupported or repeated command-line arguments. Use --help.'); }
  const { values, positionals } = parsed;
  json = values.json === true;
  if (values.help && Object.keys(values).length === 1 && positionals.length <= 1
      && (!positionals.length || commands.includes(positionals[0]))) {
    process.stdout.write(help);
  } else if (values.version && Object.keys(values).length === 1 && positionals.length === 0) {
    process.stdout.write(`${metadata.name}@${metadata.version}\n`);
  } else {
    const command = positionals[0];
    if (positionals.length !== 1 || !commands.includes(command)) usage();
    const execution = command === 'apply' || command === 'recover';
    const hasSource = ['preview', 'backup', 'apply', 'recover'].includes(command);
    const allowed = command === 'preview' ? ['config', 'cwd', 'json', 'live', 'https-auth-endpoint', 'https-auth-env']
      : command === 'backup' ? ['config', 'cwd', 'directory', 'json', 'timeout-ms', 'max-backup-bytes']
      : command === 'verify-backup' ? ['directory', 'json', 'timeout-ms', 'max-backup-bytes']
      : execution ? ['config', 'cwd', 'directory', 'json', 'timeout-ms', 'max-backup-bytes', 'expect-plan', 'https-auth-endpoint', 'https-auth-env']
      : ['directory', 'destination', 'json', 'timeout-ms', 'max-backup-bytes'];
    if (Object.keys(values).some(name => !allowed.includes(name))) usage();
    if ((hasSource && !values.config) || (execution && !values['expect-plan'])
        || (command !== 'preview' && !values.directory) || (command === 'restore-backup' && !values.destination)) usage();
    const authEndpoint = values['https-auth-endpoint'], authEnv = values['https-auth-env'];
    let httpsAuthorization;
    if (authEndpoint !== undefined || authEnv !== undefined) {
      if ((!values.live && !execution) || !authEndpoint || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(authEnv ?? '')) usage();
      httpsAuthorization = { endpoint: authEndpoint, value: process.env[authEnv] };
    }
    const options = { signal: controller.signal };
    if (values.directory) options.directory = values.directory;
    for (const [flag, name] of [['timeout-ms', 'timeoutMs'], ['max-backup-bytes', 'maxBackupBytes']]) {
      if (values[flag] !== undefined) {
        if (!/^[1-9][0-9]*$/u.test(values[flag]) || !Number.isSafeInteger(Number(values[flag]))) usage();
        options[name] = Number(values[flag]);
      }
    }
    let result;
    if (hasSource) {
      const config = await readRetirementConfig(values.config, { signal: controller.signal });
      const inspection = { ...config, cwd: resolve(values.cwd ?? process.cwd()) };
      if (command === 'backup') result = await createRetirementBackup({ ...options, inspection });
      else if (execution) {
        const execute = command === 'apply' ? applyRetirement : recoverRetirement;
        result = await execute({ ...options, inspection: { ...inspection, httpsAuthorization },
          expectedPlanId: values['expect-plan'] });
      }
      else if (values.live) result = await validateLiveRetirement({ ...inspection, signal: controller.signal, httpsAuthorization });
      else result = await inspectRetirements({ ...inspection, signal: controller.signal });
    } else if (command === 'verify-backup') result = await verifyRetirementBackup(options);
    else result = await restoreRetirementBackup({ ...options, destination: values.destination });
    if (json) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, command, result }) + '\n');
    else if (command === 'preview') {
      if (result.networkAccess) {
        process.stdout.write(`Preview only. Live advertisements matched at ${result.observation.checkedAt}. No ref changes.\n`);
        process.stdout.write(`Plan ID: ${result.planId}\n`);
      } else {
        process.stdout.write('Preview only. Remote freshness: unverified local cache. No network or ref changes.\n');
      }
      process.stdout.write(`Target: ${result.plan.target}\n`);
      for (const scope of ['remote', 'local']) {
        process.stdout.write(`${scope} temporary branches: ${result.plan[scope].length}\n`);
        for (const entry of result.plan[scope]) process.stdout.write(`  ${entry.branch} ${entry.sha} (${entry.basis})\n`);
      }
      process.stdout.write(`Local permanent branches needing alignment: ${result.plan.align.length}\n`);
      for (const name of result.plan.align) process.stdout.write(`  ${name}\n`);
    } else if (execution) {
      process.stdout.write(`Retirement verified. Remote retired: ${result.remoteRetired}; local retired: ${result.localRetired}; aligned: ${result.localAligned}.\n`);
      if (result.directory) process.stdout.write(`Backup and recovery journal: ${result.directory}\n`);
    } else {
      process.stdout.write(`Verified ${command}: ${result.refCount} refs, ${result.bundleBytes} bundle bytes.\n`);
      process.stdout.write(`Backup: ${result.directory}\nSHA256: ${result.bundleSha256}\n`);
      if (result.destination) process.stdout.write(`Fresh bare recovery: ${result.destination}\n`);
      process.stdout.write('No network access or original source ref changes.\n');
    }
  }
} catch (cause) {
  const error = cause instanceof GitReleaseGuardError ? cause : new GitReleaseGuardError('ERR_CLI_FAILURE', 'The command failed; inspect and preserve repository state before retrying.');
  if (json) process.stderr.write(JSON.stringify({ schemaVersion: 1, ok: false, error: { code: error.code, message: error.message } }) + '\n');
  else process.stderr.write(`${error.code}: ${error.message}\n`);
  process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : error.code === 'ERR_CLI_USAGE' ? 2 : 1;
} finally {
  process.removeListener('SIGINT', onSigint); process.removeListener('SIGTERM', onSigterm);
}
