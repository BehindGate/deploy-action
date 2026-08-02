'use strict';

/**
 * bg-deploy exit-code interpretation.
 *
 * Pure, dependency-free: no `@actions/*` imports.
 *
 * The mapping below was established by running the real CLI (2026.07.1) rather
 * than read off the documentation, and the two differ in a way that matters:
 *
 *   exit 2 (usage)   - missing/empty BEHINDGATE_TOKEN, no <path>, unknown flag
 *   exit 1 (runtime) - malformed token ("not a JWT"), bad base64url payload,
 *                      network failure, non-2xx from the deploy API
 *
 * Note that an *absent* token exits 2 while a *malformed* token exits 1. Both
 * are credential problems, so neither message may assume "usage error" means
 * the caller mistyped a flag.
 */

const EXIT_SUCCESS = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;

/**
 * Turn an exit code into an actionable failure message.
 *
 * The Action builds argv itself, so a usage error almost never means a mistyped
 * flag -- overwhelmingly it means the `token` input resolved to an empty string
 * (an unset secret interpolates to "" rather than failing the workflow). The
 * message says so instead of pointing at CLI syntax the user never wrote.
 *
 * @param {number} code
 * @param {{tokenLooksEmpty?: boolean, path?: string}} [context]
 * @returns {{title: string, detail: string}}
 */
function describeExitCode(code, context = {}) {
  const { tokenLooksEmpty = false, path } = context;

  if (code === EXIT_SUCCESS) {
    return { title: 'bg-deploy succeeded', detail: '' };
  }

  if (code === EXIT_USAGE) {
    const lines = [
      'bg-deploy rejected its invocation (exit 2, usage error).',
      '',
      'This Action builds the command line itself, so the usual cause is an ' +
        'empty `token` input: a secret that is not set on the repository ' +
        'interpolates to an empty string rather than failing the workflow.',
      '',
      'Check that:',
      '  - the secret referenced by `token:` exists and is non-empty ' +
        '(for example `${{ secrets.BEHINDGATE_TOKEN }}`),',
      '  - the workflow is not running from a fork, where secrets are ' +
        'unavailable by design,',
    ];
    if (path) {
      lines.push(`  - \`path:\` (${path}) names a folder or a .zip file.`);
    }
    if (tokenLooksEmpty) {
      lines.push('', 'The `token` input was empty when this step started.');
    }
    return { title: 'Invalid bg-deploy invocation', detail: lines.join('\n') };
  }

  if (code === EXIT_RUNTIME) {
    return {
      title: 'bg-deploy failed',
      detail: [
        'bg-deploy failed while running (exit 1, runtime failure).',
        '',
        'Common causes, in rough order of likelihood:',
        '  - the token is not a well-formed JWT ("error: not a JWT"), for ' +
          'example a truncated or wrapped secret,',
        '  - the token is expired or was revoked,',
        '  - the deploy endpoint rejected the release (check the CLI output above),',
        '  - the runner could not reach the endpoint.',
        '',
        'The CLI output above carries the specific error.',
      ].join('\n'),
    };
  }

  return {
    title: 'bg-deploy exited unexpectedly',
    detail:
      `bg-deploy exited with code ${code}, which is outside its documented ` +
      `range (0 success, 1 runtime failure, 2 usage error). Treating as a failure.`,
  };
}

module.exports = {
  EXIT_SUCCESS,
  EXIT_RUNTIME,
  EXIT_USAGE,
  describeExitCode,
};
