'use strict';

/**
 * Bitbucket Pipes entrypoint.
 *
 * A Pipe is a container Bitbucket runs with the build directory mounted and
 * pipe variables injected as environment variables. Unlike the GitLab
 * component -- which is YAML merged into someone else's pipeline and cannot
 * reach this repository at all -- a Pipe ships its own filesystem, so this
 * reuses `src/core/` exactly as the Action does.
 *
 * Like both siblings, it wraps the bg-deploy CLI and never reimplements the
 * deploy HTTP protocol.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const { resolvePlatform } = require('../core/platform');
const versions = require('../core/versions');
const { verifyFileChecksum } = require('../core/checksum');
const { parseDeployJson, parseErrorMessage } = require('../core/parse');
const { describeExitCode, EXIT_SUCCESS } = require('../core/errors');
const { classifyToken, TOKEN_EMPTY, TOKEN_MALFORMED } = require('../core/validate');

/** Where the Dockerfile bakes the pinned archive. */
const BAKED_DIR = process.env.BG_PIPE_ARCHIVE_DIR || '/opt/bg-deploy';

/**
 * Absolute path to tar. Resolved from a fixed list rather than through PATH,
 * which a pipe variable could otherwise influence.
 */
const TAR = ['/usr/bin/tar', '/bin/tar'].find((candidate) => fs.existsSync(candidate)) || null;

class PipeError extends Error {}

function fail(...lines) {
  throw new PipeError(lines.join('\n'));
}

function info(message) {
  console.log(message);
}

/**
 * Read a pipe variable.
 *
 * Bitbucket injects them as environment variables, so a variable named `PATH`
 * would replace the container's executable search path rather than tell us what
 * to deploy. That is why the deploy path is `DEPLOY_PATH`, and why an obvious
 * misuse is detected below instead of producing a container where nothing runs.
 */
function variable(name) {
  return String(process.env[name] ?? '').trim();
}

function resolveDeployPath() {
  const deployPath = variable('DEPLOY_PATH');
  if (deployPath) return deployPath;

  // A PATH with no separator and no absolute component is not a search path --
  // it is someone's build directory, passed under the name they guessed.
  const suspiciousPath = process.env.PATH || '';
  if (suspiciousPath && !suspiciousPath.includes(':') && !suspiciousPath.startsWith('/')) {
    fail(
      'DEPLOY_PATH is empty, and PATH looks like it was set to a directory to deploy.',
      '',
      'This pipe reads the folder to deploy from DEPLOY_PATH. A variable named',
      'PATH replaces the container\'s executable search path instead, which',
      'breaks every command in the job.',
      '',
      'Rename the variable to DEPLOY_PATH.'
    );
  }

  fail(
    'DEPLOY_PATH is empty.',
    '',
    'It must name the folder to deploy, or an existing .zip -- the folder whose',
    'CONTENTS become the site, so that index.html sits at the top of it.',
    '',
    '    - pipe: docker://behindgate/deploy-pipe:1',
    '      variables:',
    '        DEPLOY_PATH: dist'
  );
}

function resolveToken() {
  const { code, token } = classifyToken(process.env.BEHINDGATE_TOKEN);

  if (code === TOKEN_EMPTY) {
    fail(
      'BEHINDGATE_TOKEN is empty.',
      '',
      'A variable that is not set expands to an empty string rather than failing',
      'the build, so this usually means it is missing from the repository, or is',
      'defined for a deployment environment this step does not target.',
      '',
      'Add it under Repository settings -> Repository variables as a Secured',
      'variable, then pass it through:',
      '',
      '    - pipe: docker://behindgate/deploy-pipe:1',
      '      variables:',
      '        BEHINDGATE_TOKEN: $BEHINDGATE_TOKEN'
    );
  }

  if (code === TOKEN_MALFORMED) {
    fail(
      'BEHINDGATE_TOKEN is not a well-formed JWT.',
      '',
      'A BehindGate deploy token has three base64url segments separated by dots',
      '(header.payload.signature). The value supplied does not, which usually',
      'means it was truncated, wrapped across lines, or quoted when it was stored.',
      '',
      'Re-copy it from the workspace dashboard under Settings -> Deploy tokens.'
    );
  }

  return token;
}

/**
 * Produce a verified, executable CLI and return its path.
 *
 * The archive baked into the image and one downloaded at run time go through
 * exactly the same verification, so there is no path in which an unverified
 * binary executes -- including one where the image itself was altered after it
 * was built.
 */
async function acquireCli({ version, platform, baseUrl, workDir }) {
  if (!TAR) {
    fail('No tar at /usr/bin/tar or /bin/tar, so the CLI archive cannot be unpacked.');
  }

  const artifact = versions.resolveArtifact(version, platform);
  const baked = path.join(BAKED_DIR, version, artifact.archive);

  let archivePath = baked;
  let source = `the image (${baked})`;

  if (fs.existsSync(baked)) {
    info(`Using bg-deploy ${version} (${platform}) baked into this image`);
  } else {
    const url = versions.downloadUrl(baseUrl, version, artifact.archive);
    info(`Downloading bg-deploy ${version} (${platform}) from ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      fail(`Could not download ${url}: HTTP ${response.status}.`);
    }

    archivePath = path.join(workDir, artifact.archive);
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
    source = url;
  }

  // Before extraction, so a tampered archive is never unpacked next to the
  // checked-out repository.
  await verifyFileChecksum(archivePath, artifact.sha256, { source });
  info(`Checksum verified against versions.json: ${artifact.sha256}`);

  const installDir = path.join(workDir, 'cli');
  fs.mkdirSync(installDir, { recursive: true });
  execFileSync(TAR, ['-xzf', archivePath, '-C', installDir]);

  const binary = path.join(installDir, artifact.binary);
  if (!fs.existsSync(binary)) {
    fail(`The archive did not contain ${artifact.binary}.`);
  }

  // Executable by its owner only: the process that extracts it is the process
  // that runs it, and the container is thrown away afterwards.
  fs.chmodSync(binary, 0o700);

  return binary;
}

/**
 * Publish the results where a later step can pick them up.
 *
 * Bitbucket steps do not share an environment, so a file in the build directory
 * is the handoff. Written even when a field is missing, so a consumer can tell
 * "deployed, address unknown" from "never ran".
 */
function writeOutputs(cloneDir, { releaseId, url }) {
  const file = path.join(cloneDir, 'behindgate.env');
  fs.writeFileSync(
    file,
    `BEHINDGATE_RELEASE_ID=${releaseId || ''}\nBEHINDGATE_URL=${url || ''}\n`
  );
  return file;
}

async function run() {
  // Bitbucket mounts the checkout at BITBUCKET_CLONE_DIR. Anchoring to it means
  // a relative DEPLOY_PATH resolves against the repository rather than against
  // whatever the image's WORKDIR happens to be.
  const cloneDir = process.env.BITBUCKET_CLONE_DIR || process.cwd();
  process.chdir(cloneDir);

  const token = resolveToken();
  const deployPath = resolveDeployPath();

  if (!fs.existsSync(deployPath)) {
    fail(
      `DEPLOY_PATH (${deployPath}) does not exist in ${cloneDir}.`,
      '',
      'It must name the folder to deploy, or an existing .zip. If an earlier',
      'step produces it, make sure that step declares it under `artifacts:` --',
      'Bitbucket does not carry a build directory between steps otherwise.'
    );
  }

  const url = variable('DEPLOY_URL');
  const version = variable('CLI_VERSION') || versions.defaultVersion();
  const baseUrl = variable('DOWNLOAD_BASE_URL') || versions.defaultDownloadBaseUrl();

  if (!url) {
    console.error(
      'WARNING: DEPLOY_URL is not set, so the deploy endpoint comes from the token\n' +
        'WARNING: itself. A token is both a credential and a routing instruction:\n' +
        'WARNING: anyone who can change BEHINDGATE_TOKEN can redirect this upload\n' +
        'WARNING: while the step still reports success. Pin the endpoint with\n' +
        'WARNING: DEPLOY_URL and the CLI refuses to deploy if a token turns up\n' +
        'WARNING: claiming a different one.'
    );
  }

  const workDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bg-pipe-'));

  try {
    const binary = await acquireCli({
      version,
      platform: resolvePlatform(),
      baseUrl,
      workDir,
    });

    const args = ['-y', '--json'];
    if (url) args.push('--url', url);
    args.push(deployPath);

    info(`Deploying ${deployPath}`);

    // stdout and stderr stay separate: under --json, stdout carries exactly one
    // object and all progress goes to stderr. The token travels in the
    // environment, never on the command line.
    const result = spawnSync(binary, args, {
      cwd: cloneDir,
      env: { ...process.env, BEHINDGATE_TOKEN: token },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });

    if (result.error) {
      fail(`Could not run bg-deploy: ${result.error.message}`);
    }

    if (result.stderr) process.stderr.write(result.stderr);

    if (result.status !== EXIT_SUCCESS) {
      const { title, detail } = describeExitCode(result.status, {
        path: deployPath,
        urlPinned: Boolean(url),
        cliMessage: parseErrorMessage({ stdout: result.stdout, stderr: result.stderr }),
      });
      fail(title, '', detail);
    }

    const parsed = parseDeployJson(result.stdout);

    if (!parsed) {
      console.error(
        'WARNING: bg-deploy reported success but its --json output could not be\n' +
          'WARNING: parsed, so behindgate.env will be empty. This usually means the\n' +
          'WARNING: CLI changed its output contract; please open an issue.'
      );
    }

    const releaseId = parsed?.releaseId || '';
    const deployedUrl = parsed?.url || '';

    const outputs = writeOutputs(cloneDir, { releaseId, url: deployedUrl });

    info(
      deployedUrl
        ? `Deployed release ${releaseId || '(unknown)'} to ${deployedUrl}`
        : `Deployed release ${releaseId || '(unknown)'}`
    );
    info(`Wrote ${path.relative(cloneDir, outputs)}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`\n${error.message}`);
    process.exit(1);
  });
}

module.exports = { run, acquireCli, resolveDeployPath, resolveToken, writeOutputs, PipeError };
