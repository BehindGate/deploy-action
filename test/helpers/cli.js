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
const { execFileSync } = require('node:child_process');

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

  fs.mkdirSync(installDir, { recursive: true });
  const archivePath = path.join(TMP_DIR, artifact.archive);

  if (!fs.existsSync(archivePath)) {
    const url = versions.downloadUrl(baseUrl, artifact.archive);
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      return { skip: `could not reach ${url}: ${error.message}` };
    }
    if (!response.ok) {
      return { skip: `could not download ${url}: HTTP ${response.status}` };
    }
    fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));
  }

  // Same verification the Action performs, against the same committed table.
  await verifyFileChecksum(archivePath, artifact.sha256, { source: baseUrl });

  execFileSync('tar', ['-xzf', archivePath, '-C', installDir]);
  fs.chmodSync(binary, 0o755);

  return { binary };
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

module.exports = { acquireRealCli, makeSiteFixture, TMP_DIR };
