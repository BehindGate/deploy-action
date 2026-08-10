#!/usr/bin/env node
'use strict';

/**
 * Fetch a pinned bg-deploy archive and verify it against versions.json.
 *
 *   node script/fetch-cli.js --platform linux-amd64 --out /opt/bg-deploy
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

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--platform') args.platform = value;
    else if (key === '--out') args.out = value;
    else if (key === '--version') args.version = value;
    else if (key === '--base-url') args.baseUrl = value;
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.platform || !args.out) {
    console.error('Usage: node script/fetch-cli.js --platform <p> --out <dir> [--version V] [--base-url URL]');
    process.exit(2);
  }

  const version = args.version || process.env.BG_CLI_VERSION || versions.defaultVersion();
  const baseUrl =
    args.baseUrl || process.env.BG_DOWNLOAD_BASE_URL || versions.defaultDownloadBaseUrl();

  // Throws with the known platforms listed when the pin is missing, which is a
  // far better build failure than a 404 halfway through.
  const artifact = versions.resolveArtifact(version, args.platform);

  const url = versions.downloadUrl(baseUrl, version, artifact.archive);
  console.log(`Fetching bg-deploy ${version} (${args.platform}) from ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const destination = path.join(args.out, version);
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
