'use strict';

/**
 * Parsing of bg-deploy's `--json` output.
 *
 * Pure, dependency-free: no `@actions/*` imports.
 *
 * From 2026.8.0 the CLI has a structured output mode: `--json` writes exactly
 * one object to stdout and sends all human-readable progress to stderr. That is
 * the contract this Action reads. Earlier releases had no such mode and never
 * printed the deployed address at all, which is why the `url` output used to
 * ship empty; parsing console prose was the only option and broke on any wording
 * change.
 *
 * Reference stdout from a successful run (bg-deploy 2026.8.3):
 *
 *   {"releaseId":"rel_01J8ZQ","url":"https://demo.behindgate.com/my-app/",
 *    "endpoint":"https://app.behindgate.com/api/deploy","status":"published",
 *    "version":"2026.8.3"}
 */

/** Strip ANSI SGR sequences. Kept for stderr, which may be colourised. */
const ANSI = /\[[0-9;]*m/g;

function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/**
 * Pull the JSON object out of a stdout buffer.
 *
 * Tolerant of surrounding blank lines and of a stray non-JSON line, so a future
 * CLI that prints something extra does not cost us the release id. Scans for the
 * last line that parses as an object, since the result object is emitted last.
 */
function extractJson(stdout) {
  const text = stripAnsi(stdout).trim();
  if (!text) return null;

  const candidates = [text, ...text.split('\n').reverse()];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not this line; keep looking.
    }
  }

  return null;
}

/**
 * Parse a successful `--json` run.
 *
 * Returns null when nothing usable could be read, so callers can warn rather
 * than publish empty outputs as if they were real. Absent individual fields
 * come back as null rather than undefined, so the shape is stable.
 *
 * A teardown (`--delete-app`) reports a different object -- no release and no
 * deployed address, but a `path` and a `deleted` flag. `deleted` is false when
 * there was no app at that path, which is a success: a teardown job has to be
 * safe to re-run.
 *
 * @returns {{releaseId: string|null, url: string|null, endpoint: string|null, status: string|null, version: string|null, path: string|null, deleted: boolean|null}|null}
 */
function parseDeployJson(stdout) {
  const parsed = extractJson(stdout);
  if (!parsed) return null;

  const str = (value) => (typeof value === 'string' && value ? value : null);

  return {
    releaseId: str(parsed.releaseId),
    url: str(parsed.url),
    endpoint: str(parsed.endpoint),
    status: str(parsed.status),
    version: str(parsed.version),
    path: str(parsed.path),
    deleted: typeof parsed.deleted === 'boolean' ? parsed.deleted : null,
  };
}

/**
 * Pull a message out of the CLI's error output.
 *
 * `--json` emits `{"error":{"code":"...","message":"..."}}` on failure, but a
 * failure early enough in startup may still be plain text on stderr, so fall
 * back to the first `error:` line.
 */
function parseErrorMessage({ stdout = '', stderr = '' } = {}) {
  const parsed = extractJson(stdout);
  if (parsed && parsed.error && typeof parsed.error === 'object') {
    const { code, message } = parsed.error;
    if (message) return code ? `${message} (${code})` : String(message);
  }

  const match = stripAnsi(stderr).match(/^\s*error:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

module.exports = {
  stripAnsi,
  extractJson,
  parseDeployJson,
  parseErrorMessage,
};
