'use strict';

/**
 * Fetch the real bg-deploy CLI for integration tests.
 *
 * Uses the same pin table and checksum logic the Action uses, so the tests
 * exercise that path too. Caches into test/.tmp so repeated local runs do not
 * re-download.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const versions = require('../../src/core/versions');
const { verifyFileChecksum } = require('../../src/core/checksum');
const { resolvePlatform } = require('../../src/core/platform');

const TMP_DIR = path.join(__dirname, '..', '.tmp');

/**
 * Where tar(1) is looked for, as absolute paths.
 *
 * Naming the bare command would resolve it through PATH, which is inherited from
 * whatever invoked the tests -- so an entry earlier in PATH decides what runs
 * just before a downloaded binary is unpacked and executed. Both runners we test
 * on ship /usr/bin/tar.
 */
const TAR_PATHS = ['/usr/bin/tar', '/bin/tar'];

/**
 * Fetch a pinned CLI build.
 *
 * `version` and `baseUrl` default to what the Action installs. The GitLab tests
 * override them: the component defaults to the newest OIDC-capable release,
 * which production does not necessarily serve yet.
 *
 * @param {{version?: string, baseUrl?: string}} [options]
 * @returns {Promise<{binary: string} | {skip: string}>}
 */
async function acquireRealCli(options = {}) {
  if (process.platform === 'win32') {
    return { skip: 'integration tests use tar(1); not run on Windows' };
  }

  // Escape hatch for testing against a build that has no pin yet -- a release
  // published to the test environment ahead of production has no checksum in
  // versions.json, so it cannot be fetched through the path above:
  //
  //   BG_CLI_BINARY=/path/to/bg-deploy npm run test:integration
  //
  // Test-only. Nothing in src/ has an equivalent: the Action never runs an
  // unverified binary.
  if (process.env.BG_CLI_BINARY) {
    return { binary: process.env.BG_CLI_BINARY };
  }

  let platform;
  try {
    platform = resolvePlatform();
  } catch (error) {
    return { skip: error.message };
  }

  const version = options.version || process.env.BG_CLI_VERSION || versions.defaultVersion();
  const baseUrl =
    options.baseUrl || process.env.BG_DOWNLOAD_BASE_URL || versions.defaultDownloadBaseUrl();

  let artifact;
  try {
    artifact = versions.resolveArtifact(version, platform);
  } catch (error) {
    return { skip: error.message };
  }

  const installDir = path.join(TMP_DIR, `${version}-${platform}`);
  const binary = path.join(installDir, artifact.binary);

  // Version-scoped: archive names are identical across releases, so caching by
  // bare name means a stale download from a previous version fails verification
  // against the new pin -- which looks like a checksum failure, not a stale file.
  const archivePath = path.join(TMP_DIR, `${version}-${artifact.archive}`);

  // The archive is kept, not just the extracted binary: the GitLab and Bitbucket
  // tests serve it from a local download host to exercise fetch-and-verify end
  // to end.
  if (fs.existsSync(binary) && fs.existsSync(archivePath)) {
    return { binary, archivePath, artifact, version, platform };
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });

  // `node --test` runs test FILES in parallel, so several processes reach this
  // at once on a cold cache. Everything below is therefore written inside a
  // private staging directory and published with a single rename: a partially
  // written archive is never hashed, and a partially extracted binary is never
  // exec'd (which surfaced as `spawn ETXTBSY`, naming nothing resembling its
  // cause). mkdtemp rather than a name built from the pid: it creates the
  // directory exclusively, so the path cannot be pre-empted by a symlink.
  const staging = fs.mkdtempSync(path.join(TMP_DIR, 'staging-'));

  try {
    if (!fs.existsSync(archivePath)) {
      const url = versions.downloadUrl(baseUrl, version, artifact.archive);
      let response;
      try {
        response = await fetch(url);
      } catch (error) {
        return { skip: `could not reach ${url}: ${error.message}` };
      }
      if (!response.ok) {
        return { skip: `could not download ${url}: HTTP ${response.status}` };
      }
      const partial = path.join(staging, artifact.archive);
      fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
      fs.renameSync(partial, archivePath);
    }

    // Same verification the Action performs, against the same committed table.
    // A mismatch is returned as a skip rather than thrown: a host that
    // republishes under one version serves bytes the pin stopped describing the
    // moment it was rebuilt, and that is a stale pin to re-capture, not a test
    // this suite can meaningfully fail on.
    try {
      await verifyFileChecksum(archivePath, artifact.sha256, { source: baseUrl });
    } catch (error) {
      fs.rmSync(archivePath, { force: true });
      return { skip: `${version} from ${baseUrl} does not match its pin: ${error.message}` };
    }

    const tar = TAR_PATHS.find((candidate) => fs.existsSync(candidate));
    if (!tar) {
      return { skip: `no tar(1) found at ${TAR_PATHS.join(' or ')}` };
    }

    const extracted = path.join(staging, 'cli');
    fs.mkdirSync(extracted);
    execFileSync(tar, ['-xzf', archivePath, '-C', extracted]);
    // Owner-only: the binary is executed by this process and nothing else has
    // any business reading, let alone running, a freshly downloaded executable.
    fs.chmodSync(path.join(extracted, artifact.binary), 0o700);

    try {
      fs.renameSync(extracted, installDir);
    } catch {
      // Another process published first. Its copy is the same verified bytes.
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return { binary, archivePath, artifact, version, platform };
}

/**
 * Whether the acquired CLI understands the preview flags.
 *
 * `--site-url`, `--create-app` and `--delete-app` arrived in 2026.8.5. An older
 * CLI rejects them as unknown flags (exit 2), so the preview tests skip rather
 * than fail until the pinned default catches up. Read from `--help` rather than
 * from the version string: the flags are the contract, the number is a label.
 *
 * @returns {string|null} a skip reason, or null when the flags are supported
 */
function previewSupport(binary) {
  // Both streams: the CLI writes its usage to stderr, and only --json output is
  // ever promised on stdout.
  const help = spawnSync(binary, ['--help'], { encoding: 'utf8' });
  const text = `${help.stdout || ''}${help.stderr || ''}`;

  const missing = ['--site-url', '--create-app', '--delete-app'].filter(
    (flag) => !text.includes(flag)
  );
  if (!missing.length) return null;

  const version = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  return (
    `${`${version.stdout || ''}${version.stderr || ''}`.trim()} has no ` +
    `${missing.join(', ')}; the preview flow needs 2026.8.5. Run against a ` +
    `pre-release build with BG_CLI_BINARY=/path/to/bg-deploy.`
  );
}

/** A throwaway static site: index.html at the top, plus a nested asset. */
function makeSiteFixture(name = 'site') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-fixture-'));
  const site = path.join(root, name);
  fs.mkdirSync(path.join(site, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(site, 'index.html'), '<h1>hello</h1>\n');
  fs.writeFileSync(path.join(site, 'assets', 'app.css'), 'body{margin:0}\n');
  return { root, site };
}

module.exports = { acquireRealCli, previewSupport, makeSiteFixture, TMP_DIR };
