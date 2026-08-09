#!/usr/bin/env node
'use strict';

/**
 * Verify or re-capture the checksums pinned in versions.json.
 *
 *   node script/checksums.js verify [--version 2026.8.3] [--base-url https://host]
 *   node script/checksums.js bump   [--base-url https://host]
 *   node script/checksums.js write  [--version 2026.8.3] [--base-url https://host]
 *
 * `verify` re-downloads each published archive and compares it against the pin.
 * `bump` adopts whatever the release index reports as latest, adding a new entry.
 * `write` re-captures an existing entry in place -- rarely correct now that
 * downloads are versioned and immutable, so a hash that has changed under a
 * versioned path is a red flag rather than a routine re-release.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const TABLE_PATH = path.join(__dirname, '..', 'versions.json');

/**
 * Recover the version string embedded in an archived binary.
 *
 * The version key in versions.json is a hand-written label, while the checksum
 * is what binds the bytes. This keeps the two from disagreeing -- notably when
 * re-capturing after a release would otherwise file new binaries under an old
 * version number, which the tool cache keys on.
 *
 * Returns null when the version cannot be read unambiguously; callers treat that
 * as "unknown", never as a mismatch.
 */
function detectVersion(buffer, archiveName) {
  let decompressed;

  try {
    if (archiveName.endsWith('.tar.gz')) {
      decompressed = zlib.gunzipSync(buffer);
    } else if (archiveName.endsWith('.zip')) {
      const signature = buffer.indexOf(Buffer.from('PK\x03\x04', 'binary'));
      if (signature === -1) return null;
      const method = buffer.readUInt16LE(signature + 8);
      const nameLength = buffer.readUInt16LE(signature + 26);
      const extraLength = buffer.readUInt16LE(signature + 28);
      const data = buffer.subarray(signature + 30 + nameLength + extraLength);
      decompressed = method === 0 ? data : zlib.inflateRawSync(data);
    } else {
      return null;
    }
  } catch {
    return null;
  }

  const matches = new Set(
    (decompressed.toString('latin1').match(/\b20\d{2}\.\d{1,2}\.\d+\b/g) || [])
  );

  return matches.size === 1 ? [...matches][0] : null;
}

/** Archive and binary names follow directly from the platform key. */
function artifactFor(platform) {
  const windows = platform.startsWith('windows-');
  return {
    archive: `bg-deploy-${platform}.${windows ? 'zip' : 'tar.gz'}`,
    binary: windows ? 'bg-deploy.exe' : 'bg-deploy',
  };
}

function parseArgs(argv) {
  const args = { mode: argv[2] };
  for (let i = 3; i < argv.length; i += 2) {
    if (argv[i] === '--version') args.version = argv[i + 1];
    else if (argv[i] === '--base-url') args.baseUrl = argv[i + 1];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function digestOf(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  return {
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    bytes: body.length,
    body,
  };
}

async function fetchIndex(baseUrl) {
  const url = `${baseUrl}/downloads/index.json`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

function resolveBaseUrl(args, table, entry) {
  return (
    args.baseUrl ||
    process.env.BG_DOWNLOAD_BASE_URL ||
    entry?.capturedFrom ||
    table.defaultDownloadBaseUrl
  ).replace(/\/+$/, '');
}

/**
 * Adopt the version the release index reports as latest.
 *
 * The backend is a SaaS: it moves whether or not this repository does, so a
 * pinned client buys no reproducibility. Pinning exists only because the sole
 * integrity mechanism available is a hash committed here. Running this on a
 * schedule keeps the pin honest without keeping it stale.
 *
 * Adds a new entry rather than overwriting, so a previously pinned version stays
 * selectable through `cli-version` if a release turns out to be bad.
 */
async function runBump(table, args) {
  const current = table.defaultVersion;
  const baseUrl = resolveBaseUrl(args, table, null);

  let index;
  try {
    index = await fetchIndex(baseUrl);
  } catch (error) {
    console.error(`Could not read the release index: ${error.message}`);
    process.exit(1);
  }

  const version = args.version || index.latest;
  console.log(`current default: ${current}\nlatest published: ${index.latest}\n`);

  if (version === current) {
    console.log(`Already on ${current}; nothing to do.`);
    return;
  }

  const release = index.versions.find((v) => v.version === version);
  if (!release) {
    console.error(`The index does not list ${version}.`);
    process.exit(1);
  }

  const platforms = {};
  for (const platform of release.platforms) {
    const { archive, binary } = artifactFor(platform);
    let result;
    try {
      result = await digestOf(`${baseUrl}/downloads/${version}/${archive}`);
    } catch (error) {
      console.error(`  !! ${platform.padEnd(14)} ${error.message}`);
      process.exit(1);
    }

    const embedded = detectVersion(result.body, archive);
    if (embedded && embedded !== version) {
      console.error(
        `  !! ${platform.padEnd(14)} reports ${embedded}, but is published as ${version}. ` +
          `Refusing to pin a binary under a version it does not report.`
      );
      process.exit(1);
    }

    platforms[platform] = { archive, binary, sha256: result.sha256 };
    console.log(`  ${platform.padEnd(14)} ${embedded || '(undetermined)'}  ${result.sha256}`);
  }

  table.versions[version] = {
    capturedFrom: baseUrl,
    capturedAt: new Date().toISOString().slice(0, 10),
    ...(release.commit ? { commit: release.commit } : {}),
    platforms,
  };
  table.defaultVersion = version;
  fs.writeFileSync(TABLE_PATH, `${JSON.stringify(table, null, 2)}\n`);

  console.log(`\nPinned ${version} and made it the default (was ${current}).`);
  console.log(`${current} stays in the table and remains selectable via cli-version.`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (!['verify', 'write', 'bump'].includes(args.mode)) {
    console.error(
      'Usage: node script/checksums.js <verify|write|bump> [--version V] [--base-url URL]'
    );
    process.exit(2);
  }

  const table = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));

  if (args.mode === 'bump') {
    return runBump(table, args);
  }

  const version = args.version || process.env.BG_CLI_VERSION || table.defaultVersion;
  const entry = table.versions[version];
  if (!entry) {
    console.error(`versions.json has no entry for ${version}`);
    process.exit(1);
  }

  const baseUrl = resolveBaseUrl(args, table, entry);
  console.log(`bg-deploy ${version} from ${baseUrl}\n`);

  const mismatches = [];
  const failures = [];
  const versionDrift = [];

  for (const [platform, artifact] of Object.entries(entry.platforms)) {
    const url = `${baseUrl}/downloads/${version}/${artifact.archive}`;
    let result;
    try {
      result = await digestOf(url);
    } catch (error) {
      failures.push({ platform, error: error.message });
      console.log(`  ?  ${platform.padEnd(14)} ${error.message}`);
      continue;
    }

    const matches = result.sha256 === artifact.sha256;
    const embedded = detectVersion(result.body, artifact.archive);
    if (embedded && embedded !== version) versionDrift.push({ platform, embedded });

    const note = embedded
      ? embedded === version
        ? ''
        : `  << reports ${embedded}`
      : '  (version undetermined)';

    console.log(
      `  ${matches ? 'ok' : 'XX'} ${platform.padEnd(14)} ${result.sha256}  ` +
        `(${result.bytes} bytes)${note}`
    );

    if (!matches) {
      mismatches.push({ platform, pinned: artifact.sha256, served: result.sha256 });
      if (args.mode === 'write') artifact.sha256 = result.sha256;
    }
  }

  if (versionDrift.length) {
    console.error(
      `\nThe binaries do not report version ${version}:\n` +
        versionDrift.map((d) => `  ${d.platform} reports ${d.embedded}`).join('\n') +
        `\n\nversions.json would file these bytes under the wrong version, and the\n` +
        `tool cache keys on that version. Add a "${versionDrift[0].embedded}" entry\n` +
        `instead of overwriting ${version}.`
    );
    process.exit(1);
  }

  if (args.mode === 'write') {
    entry.capturedFrom = baseUrl;
    entry.capturedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(TABLE_PATH, `${JSON.stringify(table, null, 2)}\n`);
    console.log(`\nUpdated ${mismatches.length} checksum(s). Review the diff before committing.`);
    process.exit(failures.length ? 1 : 0);
  }

  if (mismatches.length) {
    console.error('\nPinned checksums do NOT match what the host is serving:\n');
    for (const m of mismatches) {
      console.error(`  ${m.platform}\n    pinned: ${m.pinned}\n    served: ${m.served}`);
    }
    console.error(
      '\nDownloads are versioned and immutable, so a published version should never\n' +
        'change bytes. Treat this as a red flag rather than a routine re-release.'
    );
    process.exit(1);
  }

  if (failures.length) {
    console.error(
      `\n${failures.length} platform(s) could not be checked against ${baseUrl}.\n` +
        `This is a reachability problem, not a checksum mismatch: the pinned\n` +
        `hashes were neither confirmed nor contradicted.`
    );
    process.exit(1);
  }

  console.log('\nAll pinned checksums match.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
