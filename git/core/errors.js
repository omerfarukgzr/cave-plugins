// Engine errors. Every failure that reaches a host is an EngineError with a stable `code` (docs/PROTOCOL.md "Errors").
// The UI branches on `code` only, never on `message`.

export const CODES = Object.freeze([
  'unknown_method', // no method with that name is registered
  'invalid_params', // a parameter is missing, of the wrong type, or not allowed (data.param names it)
  'not_a_repo', // the folder is not inside a work tree, or is a bare repository (data.reason: 'missing'|'not_a_repo'|'bare')
  'not_found', // a revision, path, job or entry does not exist
  'git_failed', // git exited non-zero where that is an error (data: { command, exitCode, stderr })
  'busy', // the resource is in use (reserved; mutating requests wait in the queue instead)
  'too_large', // content is over the size cap where text is required
  'binary', // content is binary where text is required
  'refused', // the engine refuses on purpose (data.reason says why)
  'cancelled', // the job was cancelled
  'timeout', // git did not finish in time
  'internal', // a bug in the engine
]);

export class EngineError extends Error {
  constructor(code, message, data) {
    super(message || code);
    if (!CODES.includes(code)) throw new Error('unknown error code ' + code);
    this.name = 'EngineError';
    this.code = code;
    this.data = data === undefined ? null : data;
  }

  toJSON() {
    return { code: this.code, message: this.message, data: this.data };
  }
}

export const fail = (code, message, data) => { throw new EngineError(code, message, data); };

/** Turns anything thrown inside a handler into the wire error shape. */
export function toWireError(err) {
  if (err instanceof EngineError) return err.toJSON();
  if (err && err.name === 'GitError') {
    if (err.cancelled) return { code: 'cancelled', message: 'cancelled', data: { command: err.command } };
    if (err.timedOut) return { code: 'timeout', message: 'git timed out', data: { command: err.command } };
    return { code: 'git_failed', message: err.message, data: { command: err.command, exitCode: err.exitCode, stderr: err.stderr } };
  }
  return { code: 'internal', message: (err && err.message) || String(err), data: null };
}
