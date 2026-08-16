'use strict';

/**
 * GitHub Actions entrypoint.
 *
 * This file is the ONLY place `@actions/*` may be imported. Everything with
 * reusable logic lives in `src/core/`, which stays runner-agnostic so the
 * planned Bitbucket Pipe and GitLab component can share it. This Action is a
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
const { resolveInputs, ConfigurationError } = require('./core/inputs');

const TOOL_NAME = 'bg-deploy';

/**
 * Download, verify, and cache the CLI. Returns the path to the executable.
 *
 * Verification happens on the downloaded archive BEFORE extraction, so a
 * tampered archive is never unpacked onto the runner.
 */
async function acquireCli({ version, platform, baseUrl }) {
  const artifact = versions.resolveArtifact(version, platform);

  // The tool cache keys on semver, and the vendor's version strings are not
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
 * Fail early when the job cannot mint an OIDC token.
 *
 * Without `token` the CLI authenticates as the job itself, which needs the
 * Actions token service -- and that is only reachable when the workflow grants
 * `id-token: write`. The CLI's own failure names the missing permission, but it
 * cannot know that the *other* likely cause is a `token:` whose secret was never
 * set: an unset secret interpolates to an empty string rather than failing the
 * workflow, and an empty token now selects this mode instead of failing.
 */
function requireOidcAvailable() {
  if (process.env.ACTIONS_ID_TOKEN_REQUEST_URL) return;

  throw new ConfigurationError(
    [
      'No `token` was supplied, so this job has to authenticate as itself -- ' +
        'but no OIDC token is available to it.',
      '',
      'Either the job is missing the permission that mints one:',
      '',
      '    permissions:',
      '      id-token: write',
      '',
      'or you meant to pass a deploy token and the secret behind `token:` is ' +
        'not set. An unset secret interpolates to an empty string rather than ' +
        'failing the workflow, and a fork gets no secrets at all by design.',
    ].join('\n')
  );
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

async function writeSummary({
  releaseId,
  url,
  endpoint,
  endpointSource,
  deployPath,
  siteUrl,
  version,
  deleteApp,
  deleted,
}) {
  try {
    const summary = core.summary.addHeading(
      deleteApp ? 'BehindGate teardown' : 'BehindGate deploy',
      3
    );

    if (deleteApp) {
      summary.addRaw(
        deleted
          ? `Deleted the app at <code>${siteUrl}</code>.`
          : `No app at <code>${siteUrl}</code>; nothing to delete.`,
        true
      );
    } else if (url) {
      summary.addRaw(`Deployed <a href="${url}">${url}</a>`, true);
    }

    const rows = [];

    if (!deleteApp) {
      rows.push([{ data: 'Release', header: true }, { data: releaseId || 'unknown' }]);
      rows.push([{ data: 'Source', header: true }, { data: deployPath }]);
    }
    if (siteUrl) {
      rows.push([{ data: 'Target', header: true }, { data: siteUrl }]);
    }
    rows.push([{ data: 'CLI', header: true }, { data: `bg-deploy ${version}` }]);
    rows.push([
      { data: 'Endpoint', header: true },
      { data: `${endpoint || 'unknown'} (pinned via ${endpointSource})` },
    ]);

    summary.addTable(rows);

    if (!deleteApp && !url) {
      summary.addRaw(
        'No deployed address was reported by the CLI, so there is nothing to ' +
          'link. The deploy itself succeeded.',
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

  const inputs = resolveInputs({
    env: core.getInput('env'),
    url: core.getInput('url'),
    downloadBaseUrl: core.getInput('download-base-url'),
    token: rawToken,
    path: core.getInput('path'),
    siteUrl: core.getInput('site-url'),
    createApp: core.getInput('create-app'),
    deleteApp: core.getInput('delete-app'),
  });

  const { args, deployPath, deployUrl, endpointSource, siteUrl, usesToken } = inputs;

  for (const warning of inputs.warnings) core.warning(warning);

  if (deployPath) validatePath(deployPath);
  if (!usesToken) requireOidcAvailable();

  const version = core.getInput('cli-version').trim() || versions.defaultVersion();

  const platform = resolvePlatform();
  const binary = await acquireCli({ version, platform, baseUrl: inputs.downloadBaseUrl });

  core.info(
    usesToken
      ? `Deploying to ${deployUrl} (pinned via ${endpointSource}) with a deploy token`
      : `Authenticating as this job against ${deployUrl} (pinned via ${endpointSource})`
  );

  // stdout and stderr must stay separate: under --json, stdout carries exactly
  // one JSON object and every human-readable progress line goes to stderr.
  // Merging them would leave the result unparseable.
  let stdout = '';
  let stderr = '';

  // The token goes in the environment, never on the command line, so it cannot
  // surface in a process listing or in the command echo of the step log.
  //
  // With no `token` input the variable is REMOVED rather than left to inherit:
  // the CLI picks its credential mode from the environment, so a stray
  // BEHINDGATE_TOKEN set elsewhere in the workflow would otherwise silently
  // override what the inputs asked for.
  const childEnv = { ...process.env };
  if (inputs.token) {
    childEnv.BEHINDGATE_TOKEN = inputs.token;
  } else {
    delete childEnv.BEHINDGATE_TOKEN;
  }

  const exitCode = await exec.exec(binary, args, {
    ignoreReturnCode: true,
    silent: true,
    env: childEnv,
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
      urlPinned: true,
      usesToken,
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

  // A teardown publishes no release and has no address, so both outputs are
  // empty by definition rather than by failure.
  core.setOutput('release-id', releaseId);
  core.setOutput('url', deployedUrl);

  if (inputs.deleteApp) {
    core.info(
      parsed?.deleted
        ? `Deleted the app at ${siteUrl}`
        : `No app at ${siteUrl}; nothing to delete`
    );
  } else {
    core.info(
      deployedUrl
        ? `Deployed release ${releaseId || '(unknown)'} to ${deployedUrl}`
        : `Deployed release ${releaseId || '(unknown)'}`
    );
  }

  await writeSummary({
    releaseId,
    url: deployedUrl,
    endpoint: parsed?.endpoint || deployUrl,
    endpointSource,
    deployPath,
    siteUrl,
    version: parsed?.version || version,
    deleteApp: inputs.deleteApp,
    deleted: parsed?.deleted,
  });
}

run().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});

module.exports = { run, acquireCli, requireOidcAvailable, validatePath };
