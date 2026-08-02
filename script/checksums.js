#!/usr/bin/env node
'use strict';

/**
 * Verify or re-capture the checksums pinned in versions.json.
 *
 *   node script/checksums.js verify [--version 2026.07.1] [--base-url https://host]
 *   node script/checksums.js write  [--version 2026.07.1] [--base-url https://host]
 *
 * `verify` downloads each published archive and compares it against the pinned
 * hash. Because the vendor's download URLs are unversioned, the host can begin
 * serving a different build under the same version at any time; running this in
 * CI turns that into a visible failure rather than a surprise mid-deploy.
 *
 * `write` records what the host is serving right now. Only run it when you have
 * a reason to believe the CLI was legitimately re-released, and review the diff:
 * the whole value of this file is that changing a hash requires a reviewed commit.
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
 * is what actually binds the bytes. Nothing otherwise stops the two disagreeing
 * -- and `write` updates hashes in place under the existing key, so re-capturing
 * after a CLI release files new binaries under the old version number. The tool
 * cache would then serve the new binary under the old cache key.
 *
 * Returns null when the version cannot be determined unambiguously; callers
 * treat that as "unknown", never as a mismatch.
 */
function detectVersion(buffer, archiveName) {
  let decompressed;

  try {
    if (archiveName.endsWith('.tar.gz')) {
      decompressed = zlib.gunzipSync(buffer);
    } else if (archiveName.endsWith('.zip')) {
      // Single-entry zip: read the local file header and inflate the payload.
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
    (decompressed.toString('latin1').match(/\b20\d{2}\.\d{2}\.\d+\b/g) || [])
  );

  // Exactly one candidate is a confident read; anything else is ambiguous.
  return matches.size === 1 ? [...matches][0] : null;
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

/**
 * Adopt whatever version the download host is currently serving.
 *
 * The backend is a SaaS: it moves whether or not this repository does, so a
 * pinned client buys no reproducibility. Pinning here exists only because the
 * sole integrity mechanism available is a hash committed to this repo -- there
 * are no signatures, and a SHA256SUMS.txt served beside the binaries proves
 * nothing. This mode keeps the pin honest without keeping it stale: run it on a
 * schedule, and the default follows upstream within a release rather than
 * whenever someone remembers.
 *
 * Adds a new entry rather than overwriting the old one, so a previously pinned
 * version stays selectable via `cli-version` if a release turns out to be bad.
 */
async function runBump(table, args) {
  const current = table.defaultVersion;
  const baseUrl = (
    args.baseUrl ||
    process.env.BG_DOWNLOAD_BASE_URL ||
    table.defaultDownloadBaseUrl
  ).replace(/\/+$/, '');

  console.log(`current default: ${current}\nchecking:        ${baseUrl}\n`);

  const platforms = {};
  const served = new Set();

  for (const [platform, artifact] of Object.entries(table.versions[current].platforms)) {
    let result;
    try {
      result = await digestOf(`${baseUrl}/downloads/${artifact.archive}`);
    } catch (error) {
      console.error(`  !! ${platform.padEnd(14)} ${error.message}`);
      process.exit(1);
    }

    const embedded = detectVersion(result.body, artifact.archive);
    if (!embedded) {
      console.error(
        `  !! ${platform.padEnd(14)} could not determine the served version; refusing to guess`
      );
      process.exit(1);
    }

    served.add(embedded);
    platforms[platform] = {
      archive: artifact.archive,
      binary: artifact.binary,
      sha256: result.sha256,
    };
    console.log(`  ${platform.padEnd(14)} ${embedded}  ${result.sha256}`);
  }

  if (served.size !== 1) {
    console.error(
      `\nThe host is mid-release: platforms report ${[...served].join(', ')}. ` +
        `Refusing to pin a set that is not one coherent release. Try again later.`
    );
    process.exit(1);
  }

  const version = [...served][0];

  if (version === current) {
    console.log(`\nAlready on ${current}; nothing to do.`);
    return;
  }

  if (!table.versions[version]) {
    table.versions[version] = {
      capturedFrom: baseUrl,
      capturedAt: new Date().toISOString().slice(0, 10),
      platforms,
    };
  }
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

  // Default to the host the pins were captured from, not the generic default
  // host. A checksum only means anything relative to whoever served it, so
  // "do these pins still describe their own source?" is the question this
  // answers. Pass --base-url to ask it of a different environment.
  const baseUrl = (
    args.baseUrl ||
    process.env.BG_DOWNLOAD_BASE_URL ||
    entry.capturedFrom ||
    table.defaultDownloadBaseUrl
  ).replace(/\/+$/, '');

  console.log(`bg-deploy ${version} from ${baseUrl}\n`);

  const mismatches = [];
  const failures = [];
  const versionDrift = [];

  for (const [platform, artifact] of Object.entries(entry.platforms)) {
    const url = `${baseUrl}/downloads/${artifact.archive}`;
    let result;
    try {
      result = await digestOf(url);
    } catch (error) {
      failures.push({ platform, error: error.message });
      console.log(`  ?  ${platform.padEnd(14)} ${error.message}`);
      continue;
    }

    const matches = result.sha256 === artifact.sha256;
    const mark = matches ? 'ok' : 'XX';

    const embedded = detectVersion(result.body, artifact.archive);
    if (embedded && embedded !== version) {
      versionDrift.push({ platform, embedded });
    }
    const versionNote = embedded
      ? embedded === version
        ? ''
        : `  << reports ${embedded}`
      : '  (version undetermined)';

    console.log(
      `  ${mark} ${platform.padEnd(14)} ${result.sha256}  (${result.bytes} bytes)${versionNote}`
    );

    if (!matches) {
      mismatches.push({ platform, pinned: artifact.sha256, served: result.sha256 });
      if (args.mode === 'write') artifact.sha256 = result.sha256;
    }
  }

  // A binary that disagrees with the key it is filed under is always wrong, in
  // either mode -- and in `write` mode it means the caller is about to record a
  // new release's hashes under the previous version's name.
  if (versionDrift.length) {
    console.error(
      `\nThe binaries do not report version ${version}:\n` +
        versionDrift.map((d) => `  ${d.platform} reports ${d.embedded}`).join('\n') +
        `\n\nversions.json would file these bytes under the wrong version, and the\n` +
        `tool cache keys on that version -- so runners would serve the new binary\n` +
        `from the old cache entry. Add a "${versionDrift[0].embedded}" entry to\n` +
        `versions.json and capture into that instead of overwriting ${version}.`
    );
    process.exit(1);
  }

  if (args.mode === 'write') {
    entry.capturedFrom = baseUrl;
    entry.capturedAt = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(TABLE_PATH, `${JSON.stringify(table, null, 2)}\n`);
    console.log(
      `\nUpdated ${mismatches.length} checksum(s) in versions.json. ` +
        `Review the diff before committing.`
    );
    process.exit(failures.length ? 1 : 0);
  }

  if (mismatches.length) {
    console.error('\nPinned checksums do NOT match what the host is serving:\n');
    for (const m of mismatches) {
      console.error(`  ${m.platform}\n    pinned: ${m.pinned}\n    served: ${m.served}`);
    }
    console.error(
      '\nEither the CLI was re-released under the same version (re-capture with\n' +
        '`node script/checksums.js write` and commit the reviewed diff), or the\n' +
        'host is serving something it should not be.'
    );
    process.exit(1);
  }

  if (failures.length) {
    console.error(
      `\n${failures.length} platform(s) could not be checked against ${baseUrl}.\n` +
        `This is a reachability problem, not a checksum mismatch: the pinned\n` +
        `hashes were neither confirmed nor contradicted. Verify that the host\n` +
        `exists and is reachable from here.`
    );
    process.exit(1);
  }

  console.log('\nAll pinned checksums match.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
