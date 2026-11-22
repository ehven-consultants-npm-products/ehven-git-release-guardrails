import { spawn } from 'node:child_process';
import { GitReleaseGuardError, fail } from '../errors.mjs';

/** Preserve configuration locations, but do not forward tokens or Git repository overrides. */
export function inspectionEnvironment() {
  const result = Object.create(null);
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'XDG_CONFIG_HOME', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']) {
    if (typeof process.env[key] === 'string') result[key] = process.env[key];
  }
  return { ...result, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C' };
}

/** Internal bounded subprocess primitive; never uses a shell or logs output. */
export async function runBounded(executable, args, { cwd, timeoutMs, maxOutputBytes, signal }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16 * 1024 * 1024) {
    fail('ERR_INPUT', 'Subprocess limits are outside the supported bounds.');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail('ERR_INPUT', 'Supply a valid AbortSignal.');
  if (signal?.aborted) fail(signal.reason?.name === 'TimeoutError' ? 'ERR_GIT_TIMEOUT' : 'ERR_ABORTED', 'Inspection was cancelled or exceeded its deadline.');
  return new Promise((resolve, reject) => {
    const out = [], err = [];
    let bytes = 0, failure, settled = false;
    const child = spawn(executable, args, { cwd, env: inspectionEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    function stop(code, message) {
      failure ??= new GitReleaseGuardError(code, message);
      child.kill('SIGKILL');
    }
    const timer = setTimeout(() => stop('ERR_GIT_TIMEOUT', 'Git inspection exceeded its command deadline.'), timeoutMs);
    const abort = () => stop(signal.reason?.name === 'TimeoutError' ? 'ERR_GIT_TIMEOUT' : 'ERR_ABORTED', 'Inspection was cancelled or exceeded its deadline.');
    signal?.addEventListener('abort', abort, { once: true });
    // Close the small race between the initial check and listener installation.
    if (signal?.aborted) abort();
    function collect(target, chunk) {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) { stop('ERR_GIT_OUTPUT_LIMIT', 'Git inspection exceeded its output limit.'); return; }
      if (!failure) target.push(chunk);
    }
    child.stdout.on('data', chunk => collect(out, chunk));
    child.stderr.on('data', chunk => collect(err, chunk));
    child.on('error', () => { failure ??= new GitReleaseGuardError('ERR_GIT_START', 'Git could not be started.'); });
    child.on('close', (status, killedBy) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      if (killedBy || status === null) { reject(new GitReleaseGuardError('ERR_GIT_COMMAND', 'Git inspection ended unexpectedly.')); return; }
      const stdout = Buffer.concat(out), stderr = Buffer.concat(err);
      const decoded = stdout.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(stdout)) {
        reject(new GitReleaseGuardError('ERR_GIT_ENCODING', 'Git returned unsupported non-UTF-8 output.')); return;
      }
      resolve({ status, stdout: decoded, stderrBytes: stderr.length });
    });
  });
}

export function gitReader(options) {
  return async (args, allowedStatuses = [0]) => {
    const result = await runBounded('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', ...args], options);
    if (!allowedStatuses.includes(result.status)) fail('ERR_GIT_COMMAND', 'A required local Git inspection failed.');
    return result;
  };
}
