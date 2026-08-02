'use strict';

/**
 * Parsing of bg-deploy's console output.
 *
 * Pure, dependency-free: no `@actions/*` imports.
 *
 * Reference output from a successful run (bg-deploy 2026.07.1):
 *
 *   Deploying to https://app.example.behindgate.net/api/deploy
 *     from public
 *   Requesting a release…
 *   Uploading 420 bytes…
 *   Waiting for extraction…
 *   Publishing…
 *   ✓ Deployed. Release rel_01J8ZQ is live.
 */

/** Strip ANSI SGR sequences so parsing survives a colourising CLI. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

/**
 * The release identifier from the success line.
 * Format string in the binary: " Deployed. Release %s is live."
 */
function parseReleaseId(output) {
  const match = stripAnsi(output).match(/Deployed\.\s+Release\s+(\S+?)\s+is live/);
  return match ? match[1] : null;
}

/**
 * The deploy API endpoint the CLI actually used.
 *
 * Worth surfacing: when `url` is not pinned this reflects the endpoint claimed
 * by the token, which is the value an attacker who can rewrite the secret would
 * have changed. It is the API endpoint, NOT the public address of the site.
 */
function parseEndpoint(output) {
  const match = stripAnsi(output).match(/^Deploying to\s+(\S+)/m);
  return match ? match[1] : null;
}

/**
 * The public URL of the deployed site, if the CLI printed one.
 *
 * As of bg-deploy 2026.07.1 it does NOT: the success line carries only the
 * release id, and the `url` field the API returns is never echoed. This
 * deliberately returns null rather than inventing a URL from the endpoint --
 * a wrong link in a job summary is worse than no link.
 *
 * The patterns below are the shapes a future CLI would plausibly use, so the
 * `url` output starts working the moment upstream adds it. Tracked upstream;
 * see README "Known gaps".
 */
function parseLiveUrl(output) {
  const clean = stripAnsi(output);
  const patterns = [
    /(?:is )?live at\s+(https?:\/\/\S+?)[\s.]*$/im,
    /(?:available|deployed) at\s+(https?:\/\/\S+?)[\s.]*$/im,
    /^\s*(?:URL|Visit):\s*(https?:\/\/\S+?)[\s.]*$/im,
  ];

  for (const pattern of patterns) {
    const match = clean.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/** True when the CLI printed its success line. */
function isSuccessOutput(output) {
  return /Deployed\.\s+Release\s+\S+\s+is live/.test(stripAnsi(output));
}

/**
 * Everything worth extracting from a run, in one pass.
 *
 * @returns {{releaseId: string|null, endpoint: string|null, url: string|null, succeeded: boolean}}
 */
function parseDeployOutput(output) {
  return {
    releaseId: parseReleaseId(output),
    endpoint: parseEndpoint(output),
    url: parseLiveUrl(output),
    succeeded: isSuccessOutput(output),
  };
}

module.exports = {
  stripAnsi,
  parseReleaseId,
  parseEndpoint,
  parseLiveUrl,
  isSuccessOutput,
  parseDeployOutput,
};
