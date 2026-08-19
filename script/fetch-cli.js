#!/usr/bin/env node
'use strict';

/**
 * Fetch a pinned bg-deploy archive and verify it against versions.json.
 *
 *   node script/fetch-cli.js --platform linux-amd64
 *
 * Writes to /opt/bg-deploy/<version>/<archive>, which is where the Pipe's
 * entrypoint looks. The destination is a constant rather than an argument: this
 * has exactly one caller, and a path assembled from argv is a path that steers
 * a filesystem write from the command line for no benefit.
 *
 * Used by the Bitbucket Pipe's Dockerfile to bake the archive into the image,
 * so the common path involves no download at run time.
 *
 * The ARCHIVE is stored, not the extracted binary. The entrypoint re-hashes it
 * against the same pin on every run and extracts from there, which keeps one
 * code path for baked and downloaded archives -- and means an image whose
 * contents were altered after the build is caught by the same check that
 * catches a tampered download.
 */

const fs = require('node:fs');
const path = require('node:path');

const versions = require('../src/core/versions');
const { verifyFileChecksum } = require('../src/core/checksum');

/** Where the Pipe's entrypoint looks for a baked archive. */
const OUT_DIR = '/opt/bg-deploy';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--platform') args.platform = value;
    else if (key === '--version') args.version = value;
    else if (key === '--base-url') args.baseUrl = value;
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

/**
 * Every argument is checked before it reaches the network or the filesystem.
 *
 * This runs during `docker build` with arguments from the Dockerfile, so the
 * inputs are not hostile today. They are still the only things steering a fetch,
 * and the checks are cheap: a version that is not pinned cannot name a URL, and
 * a base URL that is not http(s) cannot be requested.
 */
function validated(args) {
  const version = args.version || process.env.BG_CLI_VERSION || versions.defaultVersion();
  const known = versions.knownVersions();

  if (!known.includes(version)) {
    throw new Error(
      `bg-deploy ${version} is not pinned in versions.json. Known versions: ${known.join(', ')}.`
    );
  }

  const rawBaseUrl =
    args.baseUrl || process.env.BG_DOWNLOAD_BASE_URL || versions.defaultDownloadBaseUrl();

  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new Error(`The download base URL (${rawBaseUrl}) is not a URL.`);
  }

  if (baseUrl.protocol !== 'https:' && baseUrl.protocol !== 'http:') {
    throw new Error(
      `The download base URL (${rawBaseUrl}) must be http or https, not ${baseUrl.protocol}`
    );
  }

  // Returned as-is: downloadUrl() strips trailing slashes itself, so doing it
  // here was both duplicated and a `+$` regex, which backtracks quadratically
  // on a long run of slashes.
  return { version, baseUrl: baseUrl.href };
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.platform) {
    console.error('Usage: node script/fetch-cli.js --platform <p> [--version V] [--base-url URL]');
    process.exit(2);
  }

  const { version, baseUrl } = validated(args);

  // Throws with the known platforms listed when the pin is missing, which is a
  // far better build failure than a 404 halfway through. It also constrains the
  // archive name to one this repository committed, rather than one composed
  // from an argument.
  const artifact = versions.resolveArtifact(version, args.platform);

  const url = versions.downloadUrl(baseUrl, version, artifact.archive);
  console.log(`Fetching bg-deploy ${version} (${args.platform}) from ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  // Every component of the path is fixed or committed: OUT_DIR is a constant,
  // `version` is one of the keys in versions.json, and `artifact.archive` is the
  // name recorded there. None of it comes from argv.
  const destination = path.join(OUT_DIR, version);
  fs.mkdirSync(destination, { recursive: true });

  const archivePath = path.join(destination, artifact.archive);
  fs.writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

  await verifyFileChecksum(archivePath, artifact.sha256, { source: url });
  console.log(`Checksum verified against versions.json: ${artifact.sha256}`);
  console.log(`Wrote ${archivePath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
