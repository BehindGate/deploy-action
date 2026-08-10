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
 * Absolute path to tar, or null where there is none.
 *
 * Resolved from a fixed list rather than looked up on PATH. PATH is inherited
 * from whoever starts the tests, so resolving through it means the suite
 * unpacks the CLI with whichever `tar` happens to sit earliest in it -- a
 * writable directory ahead of /usr/bin is all it takes to choose the binary
 * that runs here.
 */
const TAR = ['/usr/bin/tar', '/bin/tar'].find((candidate) => fs.existsSync(candidate)) || null;

/**
 * @returns {Promise<{binary: string} | {skip: string}>}
 */
async function acquireRealCli() {
  if (process.platform === 'win32') {
    return { skip: 'integration tests use tar(1); not run on Windows' };
  }

  if (!TAR) {
    return { skip: 'no tar at /usr/bin/tar or /bin/tar' };
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

  // Version-scoped: archive names are identical across releases, so caching by
  // bare name means a stale download from a previous version fails verification
  // against the new pin -- which looks like a checksum failure, not a stale file.
  const archivePath = path.join(TMP_DIR, `${version}-${artifact.archive}`);

  // The archive is kept, not just the extracted binary: the GitLab component
  // tests serve it from a local download host to exercise the fetch-and-verify
  // path end to end.
  if (fs.existsSync(binary) && fs.existsSync(archivePath)) {
    return { binary, archivePath, artifact, version, platform };
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });

  // Everything below publishes into the cache by rename, which is atomic within
  // a directory. `node --test` runs each test FILE in its own process, and more
  // than one of them calls this, so a plain write would let one process read an
  // archive another is still writing -- a half-written file that fails its
  // checksum, or a partially extracted binary. Both surface as a thrown `before`
  // hook, which the runner reports as cancelled subtests rather than as a
  // failure, so the cause is invisible in the log.
  const unique = `${process.pid}.partial`;

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

    const partial = `${archivePath}.${unique}`;
    fs.writeFileSync(partial, Buffer.from(await response.arrayBuffer()));
    fs.renameSync(partial, archivePath);
  }

  // Same verification the Action performs, against the same committed table.
  await verifyFileChecksum(archivePath, artifact.sha256, { source: baseUrl });

  if (!fs.existsSync(binary)) {
    const staging = `${installDir}.${unique}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });

    execFileSync(TAR, ['-xzf', archivePath, '-C', staging]);

    // Executable by its owner only. Nothing else runs this binary: the process
    // that extracts it is the process that invokes it, so the group and world
    // bits would grant reach to accounts that have no business with it.
    fs.chmodSync(path.join(staging, artifact.binary), 0o700);

    try {
      fs.renameSync(staging, installDir);
    } catch {
      // Another process published first. Its copy came from the same verified
      // archive, so use it and drop ours.
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  return { binary, archivePath, artifact, version, platform };
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
