#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import metadata from '../package.json' with { type: 'json' };
import { inspectRetirements, readRetirementConfig } from '../src/node/index.mjs';
import { GitReleaseGuardError } from '../src/errors.mjs';

const help = `Usage: ehven-git-release-guardrails preview --config FILE [--cwd ROOT] [--json]
       ehven-git-release-guardrails --help
       ehven-git-release-guardrails --version

Preview integrated temporary branches using local Git and cached remote refs.
This development command performs no network request, ref update or deletion.
It is not live remote proof or an execution authorization.

--config FILE  Required schemaVersion 1 JSON file (regular, at most 1 MiB).
--cwd ROOT     Repository root; defaults to the current working directory.
--json         Machine-readable result on stdout; errors on stderr.

Relative paths are resolved from the invocation directory. Configuration never
loads executable modules or expands environment variables. Apply, fetch, backup,
restore and deployment commands are not available in this development candidate.
`;

const args = process.argv.slice(2);
let json = args.includes('--json');
const controller = new AbortController();
let interrupted;
const onInterrupt = signal => { interrupted = signal; controller.abort(); };
const onSigint = () => onInterrupt('SIGINT'), onSigterm = () => onInterrupt('SIGTERM');
process.on('SIGINT', onSigint); process.on('SIGTERM', onSigterm);
try {
  let parsed;
  try {
    parsed = parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: {
      config: { type: 'string' }, cwd: { type: 'string' }, json: { type: 'boolean' },
      help: { type: 'boolean' }, version: { type: 'boolean' },
    } });
    const names = parsed.tokens.filter(token => token.kind === 'option').map(token => token.name);
    if (new Set(names).size !== names.length) throw new Error();
  } catch { throw new GitReleaseGuardError('ERR_CLI_USAGE', 'Unsupported or repeated command-line arguments. Use --help.'); }
  const { values, positionals } = parsed;
  json = values.json === true;
  if (values.help && !values.version && !values.config && !values.cwd && !json && positionals.length <= 1
      && (!positionals.length || positionals[0] === 'preview')) {
    process.stdout.write(help);
  } else if (values.version && Object.keys(values).length === 1 && positionals.length === 0) {
    process.stdout.write(`${metadata.name}@${metadata.version}\n`);
  } else {
    if (values.help || values.version || positionals.length !== 1 || positionals[0] !== 'preview' || !values.config) {
      throw new GitReleaseGuardError('ERR_CLI_USAGE', 'Select preview with --config FILE, or use --help.');
    }
    const config = await readRetirementConfig(values.config, { signal: controller.signal });
    const result = await inspectRetirements({ ...config, cwd: resolve(values.cwd ?? process.cwd()), signal: controller.signal });
    if (json) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, command: 'preview', result }) + '\n');
    else {
      process.stdout.write('Preview only. Remote freshness: unverified local cache. No network or ref changes.\n');
      process.stdout.write(`Target: ${result.plan.target}\n`);
      for (const scope of ['remote', 'local']) {
        process.stdout.write(`${scope} temporary branches: ${result.plan[scope].length}\n`);
        for (const entry of result.plan[scope]) process.stdout.write(`  ${entry.branch} ${entry.sha} (${entry.basis})\n`);
      }
      process.stdout.write(`Local permanent branches needing alignment: ${result.plan.align.length}\n`);
      for (const name of result.plan.align) process.stdout.write(`  ${name}\n`);
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
