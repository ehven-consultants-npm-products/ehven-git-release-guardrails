/** A public, stable failure code. Input values are deliberately omitted. */
export class GitReleaseGuardError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'GitReleaseGuardError';
    this.code = code;
  }
}

export function fail(code, message) {
  throw new GitReleaseGuardError(code, message);
}
