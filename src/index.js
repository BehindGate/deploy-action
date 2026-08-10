'use strict';

/**
 * GitHub Actions entrypoint.
 *
 * This file is the ONLY place `@actions/*` may be imported. Everything with
 * reusable logic lives in `src/core/`, which stays runner-agnostic so a wrapper
 * for another CI system can share it. This Action is a
 * thin wrapper around the bg-deploy CLI and deliberately does not reimplement
 * the deploy HTTP protocol.
 */

const path = require('node:path');
const fs = require('node:fs');

const core = require('@actions/core');
const exec = require('@actions/exec');
const tc = require('@actions/tool-cache');

const { resolvePlatform } = require('./core/platform');
const versions = require('./core/versions');
const { verifyFileChecksum } = require('./core/checksum');
const { parseDeployJson, parseErrorMessage } = require('./core/parse');
const { describeExitCode, EXIT_SUCCESS } = require('./core/errors');

const TOOL_NAME = 'bg-deploy';

/**
 * Download, verify, and cache the CLI. Returns the path to the executable.
 *
 * Verification happens on the downloaded archive BEFORE extraction, so a
 * tampered archive is never unpacked onto the runner.
 */
async function acquireCli({ version, platform, baseUrl }) {
  const artifact = versions.resolveArtifact(version, platform);

  // The tool cache keys on semver, and the CLI's version strings are not
  // valid semver (`2026.07.1`). Store and look up under a normalised value, or
  // the lookup silently misses and every run re-downloads the CLI.
  const cacheVersion = versions.semverSafeVersion(version);

  const cached = cacheVersion ? tc.find(TOOL_NAME, cacheVersion, platform) : '';
  if (cached) {
    core.info(`Using cached bg-deploy ${version} (${platform}) from ${cached}`);
    return path.join(cached, artifact.binary);
  }

  const url = versions.downloadUrl(baseUrl, version, artifact.archive);
  core.info(`Downloading bg-deploy ${version} (${platform}) from ${url}`);

  const archivePath = await tc.downloadTool(url);

  await verifyFileChecksum(archivePath, artifact.sha256, { source: url });
  core.info(`Checksum verified against versions.json: ${artifact.sha256}`);

  const extractedDir = artifact.archive.endsWith('.zip')
    ? await tc.extractZip(archivePath)
    : await tc.extractTar(archivePath);

  let installDir = extractedDir;
  if (cacheVersion) {
    installDir = await tc.cacheDir(extractedDir, TOOL_NAME, cacheVersion, platform);
  } else {
    core.warning(
      `bg-deploy version "${version}" cannot be normalised to semver, so it ` +
        `cannot be cached and will be downloaded again on every run.`
    );
  }

  const binary = path.join(installDir, artifact.binary);

  if (process.platform !== 'win32') {
    fs.chmodSync(binary, 0o755);
  }

  return binary;
}

/**
 * Fail early on an empty token with a message that names the real cause.
 *
 * An unset secret interpolates to an empty string rather than failing the
 * workflow, so this is by far the most common way the step goes wrong.
 */
function validateToken(rawToken) {
  const token = rawToken.trim();

  if (!token) {
    throw new Error(
      [
        'The `token` input is empty.',
        '',
        'A secret that is not set interpolates to an empty string rather than ' +
          'failing the workflow, so this usually means the secret is missing ' +
          'or the workflow is running from a fork (where secrets are ' +
          'unavailable by design).',
        '',
        'Set a deploy token under Settings -> Secrets and variables -> Actions, ' +
          'then reference it as `token: ${{ secrets.BEHINDGATE_TOKEN }}`.',
      ].join('\n')
    );
  }

  // bg-deploy exits 1 with "error: not a JWT" for this, which is the same exit
  // code as a network failure or a rejected release. Checking here separates a
  // malformed secret from a genuine deploy failure. The token itself is never
  // included in the message.
  const segments = token.split('.');
  const looksLikeJwt =
    segments.length === 3 &&
    segments[0].length > 0 &&
    segments[1].length > 0 &&
    segments.every((segment) => /^[A-Za-z0-9_-]*$/.test(segment));

  if (!looksLikeJwt) {
    throw new Error(
      [
        'The `token` input is not a well-formed JWT.',
        '',
        'A BehindGate deploy token has three base64url segments separated by ' +
          'dots (header.payload.signature). The value supplied does not, which ' +
          'usually means it was truncated, wrapped across lines, or quoted when ' +
          'it was stored as a secret.',
        '',
        'Re-copy the token from the workspace dashboard under ' +
          'Settings -> Deploy tokens.',
      ].join('\n')
    );
  }

  return token;
}

/** Fail early on a bad path; the CLI validates the token first and would mask this. */
function validatePath(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(
      `The \`path\` input (${inputPath}) does not exist on the runner. ` +
        `It must name the folder to deploy, or an existing .zip. ` +
        `If it is produced by a build step, make sure that step runs first.`
    );
  }
  return inputPath;
}

async function writeSummary({ releaseId, url, endpoint, deployPath, version, pinned }) {
  try {
    const summary = core.summary.addHeading('BehindGate deploy', 3);

    if (url) {
      summary.addRaw(`Deployed <a href="${url}">${url}</a>`, true);
    }

    const rows = [
      [{ data: 'Release', header: true }, { data: releaseId || 'unknown' }],
      [{ data: 'Source', header: true }, { data: deployPath }],
      [{ data: 'CLI', header: true }, { data: `bg-deploy ${version}` }],
      [
        { data: 'Endpoint', header: true },
        {
          data: `${endpoint || 'unknown'}${
            pinned ? ' (pinned via <code>url</code>)' : ' (from token claim)'
          }`,
        },
      ],
    ];
    summary.addTable(rows);

    if (!url) {
      summary.addRaw(
        'No deployed address was reported by the CLI, so there is nothing to ' +
          'link. The deploy itself succeeded.',
        true
      );
    }

    if (!pinned) {
      summary.addRaw(
        '<strong>Endpoint not pinned.</strong> The upload target came from the ' +
          "token's own claim. Set the <code>url</code> input to pin it: the CLI " +
          'then refuses to deploy when a token claims a different endpoint, ' +
          'instead of quietly sending the build wherever the token says.',
        true
      );
    }

    await summary.write();
  } catch (error) {
    // A summary is a nicety; never fail a successful deploy over it.
    core.debug(`Could not write job summary: ${error.message}`);
  }
}

async function run() {
  const rawToken = core.getInput('token');

  // Mask before anything else can echo it, and mask the trimmed form too, since
  // that is the value actually handed to the CLI.
  if (rawToken) {
    core.setSecret(rawToken);
    const trimmed = rawToken.trim();
    if (trimmed && trimmed !== rawToken) core.setSecret(trimmed);
  }

  const token = validateToken(rawToken);
  const deployPath = validatePath(core.getInput('path', { required: true }));
  const url = core.getInput('url').trim();
  const version = core.getInput('cli-version').trim() || versions.defaultVersion();
  const baseUrl =
    core.getInput('download-base-url').trim() || versions.defaultDownloadBaseUrl();

  const platform = resolvePlatform();
  const binary = await acquireCli({ version, platform, baseUrl });

  const args = ['-y', '--json'];
  if (url) {
    args.push('--url', url);
  } else {
    core.warning(
      'No `url` input set, so the deploy endpoint comes from the token itself. ' +
        'A token is both a credential and a routing instruction: anyone who can ' +
        'change the secret can redirect this upload while the job still reports ' +
        'success. Pin the endpoint with `url:` and the CLI will refuse to deploy ' +
        'if a token turns up claiming a different one.'
    );
  }
  args.push(deployPath);

  // stdout and stderr must stay separate: under --json, stdout carries exactly
  // one JSON object and every human-readable progress line goes to stderr.
  // Merging them would leave the result unparseable.
  let stdout = '';
  let stderr = '';

  // The token goes in the environment, never on the command line, so it cannot
  // surface in a process listing or in the command echo of the step log.
  const exitCode = await exec.exec(binary, args, {
    ignoreReturnCode: true,
    silent: true,
    env: { ...process.env, BEHINDGATE_TOKEN: token },
    listeners: {
      stdout: (data) => {
        stdout += data.toString();
      },
      stderr: (data) => {
        const text = data.toString();
        stderr += text;
        // Echo the CLI's progress so the step log still reads normally.
        process.stderr.write(text);
      },
    },
  });

  if (exitCode !== EXIT_SUCCESS) {
    const { title, detail } = describeExitCode(exitCode, {
      path: deployPath,
      urlPinned: Boolean(url),
      cliMessage: parseErrorMessage({ stdout, stderr }),
    });
    core.setFailed(`${title}\n\n${detail}`);
    return;
  }

  const parsed = parseDeployJson(stdout);

  if (!parsed) {
    core.warning(
      'bg-deploy reported success but its --json output could not be parsed, ' +
        'so the `release-id` and `url` outputs will be empty. This usually ' +
        'means the CLI changed its output contract; please open an issue.'
    );
  }

  const releaseId = parsed?.releaseId || '';
  const deployedUrl = parsed?.url || '';

  core.setOutput('release-id', releaseId);
  core.setOutput('url', deployedUrl);

  core.info(
    deployedUrl
      ? `Deployed release ${releaseId || '(unknown)'} to ${deployedUrl}`
      : `Deployed release ${releaseId || '(unknown)'}`
  );

  await writeSummary({
    releaseId,
    url: deployedUrl,
    endpoint: parsed?.endpoint,
    deployPath,
    version: parsed?.version || version,
    pinned: Boolean(url),
  });
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

module.exports = { run, acquireCli, validateToken, validatePath };
