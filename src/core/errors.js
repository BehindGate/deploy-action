'use strict';

/**
 * bg-deploy exit-code interpretation.
 *
 * Pure, dependency-free: no `@actions/*` imports.
 *
 * The mapping below was established by running the real CLI (2026.8.3), not read
 * off documentation. It changed in 2026.8.x and the change matters:
 *
 *   exit 2 (configuration) - missing OR malformed BEHINDGATE_TOKEN, no <path>,
 *                            unknown flag, and endpoint mismatch between the
 *                            pinned URL and the token's claim
 *   exit 1 (runtime)       - network failure, non-2xx from the deploy API,
 *                            anything that goes wrong once the deploy is under way
 *
 * Previously a *malformed* token exited 1 while a *missing* one exited 2, so the
 * two halves of the same problem landed in different buckets. They are now both
 * 2, which is what makes the code usable: 2 means "fix your configuration",
 * 1 means "the deploy itself failed".
 */

const EXIT_SUCCESS = 0;
const EXIT_RUNTIME = 1;
const EXIT_CONFIG = 2;

// Retained under the old name so nothing silently reads a stale meaning.
const EXIT_USAGE = EXIT_CONFIG;

/**
 * Turn an exit code into an actionable failure message.
 *
 * @param {number} code
 * @param {{path?: string, urlPinned?: boolean, cliMessage?: string|null}} [context]
 * @returns {{title: string, detail: string}}
 */
function describeExitCode(code, context = {}) {
  const { path, urlPinned = false, cliMessage = null } = context;
  const reported = cliMessage ? `\nbg-deploy reported: ${cliMessage}\n` : '';

  if (code === EXIT_SUCCESS) {
    return { title: 'bg-deploy succeeded', detail: '' };
  }

  if (code === EXIT_CONFIG) {
    const lines = ['bg-deploy rejected the request as misconfigured (exit 2).', reported];

    // This Action validates the token's shape and the path before invoking the
    // CLI, so the causes it could have caught are already ruled out. What is
    // left is overwhelmingly the endpoint check -- and that one is security
    // relevant, so it leads.
    if (urlPinned) {
      lines.push(
        'Because this Action already checks the token format and the path ' +
          'before running, the most likely cause is that the `url` input does ' +
          'not match the endpoint your token was minted for. Since 2026.8.x the ' +
          'CLI refuses to deploy on that mismatch rather than silently ' +
          'preferring one of them.',
        '',
        'That refusal is the desired behaviour: a token whose endpoint claim ' +
          'disagrees with your pinned `url` is exactly what a swapped secret ' +
          'looks like. Check that:',
        '  - `url` names the endpoint shown when you deploy without it, and',
        '  - the token really was issued for that environment ' +
          '(a test-environment token cannot deploy to production).'
      );
    } else {
      lines.push(
        'Check that:',
        '  - the secret referenced by `token:` exists and is non-empty ' +
          '(an unset secret interpolates to an empty string rather than ' +
          'failing the workflow),',
        '  - the workflow is not running from a fork, where secrets are ' +
          'unavailable by design,',
        '  - the token has not expired or been revoked.'
      );
    }

    if (path) {
      lines.push('', `The deployed path was: ${path}`);
    }

    return { title: 'bg-deploy configuration error', detail: lines.join('\n') };
  }

  if (code === EXIT_RUNTIME) {
    return {
      title: 'bg-deploy failed',
      detail: [
        'bg-deploy failed while running (exit 1, runtime failure).',
        reported,
        'This is a failure of the deploy itself rather than of its configuration:',
        '  - the deploy endpoint rejected the release,',
        '  - the runner could not reach the endpoint, or',
        '  - the upload was interrupted.',
        '',
        'The CLI output above carries the specific error. Re-running is often ' +
          'worthwhile, since these are frequently transient.',
      ].join('\n'),
    };
  }

  return {
    title: 'bg-deploy exited unexpectedly',
    detail:
      `bg-deploy exited with code ${code}, which is outside its documented ` +
      `range (0 success, 1 runtime failure, 2 configuration error). ` +
      `Treating as a failure.${reported}`,
  };
}

module.exports = {
  EXIT_SUCCESS,
  EXIT_RUNTIME,
  EXIT_CONFIG,
  EXIT_USAGE,
  describeExitCode,
};
