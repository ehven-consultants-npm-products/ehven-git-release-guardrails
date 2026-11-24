import { spawn } from 'node:child_process';
import { GitReleaseGuardError, fail } from '../errors.mjs';
import { GIT_LOCAL_ARGS, inspectionEnvironment } from './process.mjs';

/** Binary streaming: backpressure to the exclusive file, never a whole-pack buffer. */
export async function writeBundle(handle, { cwd, timeoutMs, maxBackupBytes, signal }) {
  if (signal.aborted) fail('ERR_ABORTED', 'Backup was cancelled.');
  const child = spawn('git', [...GIT_LOCAL_ARGS, 'bundle', 'create', '--quiet', '-', '--all'], {
    cwd, env: inspectionEnvironment(), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let failure, bytes = 0, diagnostics = 0;
  const stop = (code, message) => {
    failure ??= new GitReleaseGuardError(code, message);
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  };
  const closed = new Promise(resolve => {
    child.once('error', () => stop('ERR_GIT_START', 'Git could not be started.'));
    child.once('close', (status, by) => resolve({ status, by }));
  });
  child.stderr.on('data', data => {
    diagnostics += data.length;
    if (diagnostics > 1024 * 1024) stop('ERR_GIT_OUTPUT_LIMIT', 'Backup diagnostics exceeded the supported limit.');
  });
  const timer = setTimeout(() => stop('ERR_GIT_TIMEOUT', 'Backup exceeded its command deadline.'), timeoutMs);
  const aborted = () => stop(signal.reason?.name === 'TimeoutError' ? 'ERR_GIT_TIMEOUT' : 'ERR_ABORTED', 'Backup was cancelled or exceeded its deadline.');
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  try {
    try {
      for await (const chunk of child.stdout) {
        if (failure) break;
        bytes += chunk.length;
        if (bytes > maxBackupBytes) { stop('ERR_BACKUP_LIMIT', 'Backup exceeds the supported byte limit.'); break; }
        let offset = 0;
        while (offset < chunk.length) {
          if (signal.aborted) { aborted(); break; }
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
          if (!bytesWritten) throw new Error();
          offset += bytesWritten;
        }
      }
    } catch { stop('ERR_BACKUP_IO', 'Backup data could not be written.'); }
    const { status, by } = await closed;
    if (failure) throw failure;
    if (status !== 0 || by || diagnostics) fail('ERR_GIT_COMMAND', 'Git could not create a complete warning-free backup.');
    await handle.sync();
    return bytes;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', aborted);
  }
}
