'use strict';

/**
 * Shape checks every wrapper performs before invoking the CLI.
 *
 * Pure, dependency-free: no `@actions/*` imports.
 *
 * These return a code rather than a message, on purpose. The *logic* must not
 * drift between the Action, the GitLab component and the Bitbucket Pipe -- a
 * token the Action rejects and the Pipe accepts is a bug in one of them. The
 * *wording* must differ: one talks about inputs and repository secrets, another
 * about CI/CD variables, a third about pipe variables. Sharing a message would
 * send people to a settings page their CI does not have.
 */

const TOKEN_OK = 'ok';
const TOKEN_EMPTY = 'empty';
const TOKEN_MALFORMED = 'malformed';

/**
 * Classify a deploy token by shape alone. Never inspects or returns the value
 * beyond trimming it.
 *
 * The CLI exits 2 for both a missing and a malformed token, which is also how
 * it reports a bad path and an endpoint mismatch. Separating them here is what
 * lets each wrapper name the actual cause instead of listing four.
 *
 * @param {string} rawToken
 * @returns {{code: 'ok'|'empty'|'malformed', token: string}}
 */
function classifyToken(rawToken) {
  const token = String(rawToken ?? '').trim();

  if (!token) return { code: TOKEN_EMPTY, token };

  // Three base64url segments: header.payload.signature. A truncated, wrapped or
  // quoted value fails here rather than several seconds later inside the CLI.
  const segments = token.split('.');
  const looksLikeJwt =
    segments.length === 3 &&
    segments[0].length > 0 &&
    segments[1].length > 0 &&
    segments.every((segment) => /^[A-Za-z0-9_-]*$/.test(segment));

  return { code: looksLikeJwt ? TOKEN_OK : TOKEN_MALFORMED, token };
}

module.exports = {
  classifyToken,
  TOKEN_OK,
  TOKEN_EMPTY,
  TOKEN_MALFORMED,
};
