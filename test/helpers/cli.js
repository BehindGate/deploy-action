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
 * @returns {Promise<{binary: string} | {skip: string}>}
 */
async function acquireRealCli() {
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

  const version = process.env.BG_CLI_VERSION || versions.defaultVersion();
  const baseUrl = process.env.BG_DOWNLOAD_BASE_URL || versions.defaultDownloadBaseUrl();
  const artifact = versions.resolveArtifact(version, platform);

  const installDir = path.join(TMP_DIR, `${version}-${platform}`);
  const binary = path.join(installDir, artifact.binary);
  if (fs.existsSync(binary)) return { binary };

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
    // Version-scoped: archive names are identical across releases, so caching by
    // bare name means a stale download from a previous version fails
    // verification against the new pin -- which looks like a checksum failure,
    // not a stale file.
    const archivePath = path.join(TMP_DIR, `${version}-${artifact.archive}`);

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
    await verifyFileChecksum(archivePath, artifact.sha256, { source: baseUrl });

    const extracted = path.join(staging, 'cli');
    fs.mkdirSync(extracted);
    execFileSync('tar', ['-xzf', archivePath, '-C', extracted]);
    fs.chmodSync(path.join(extracted, artifact.binary), 0o755);

    try {
      fs.renameSync(extracted, installDir);
    } catch {
      // Another process published first. Its copy is the same verified bytes.
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  return { binary };
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
