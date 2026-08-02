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

const TABLE_PATH = path.join(__dirname, '..', 'versions.json');

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
  };
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.mode !== 'verify' && args.mode !== 'write') {
    console.error('Usage: node script/checksums.js <verify|write> [--version V] [--base-url URL]');
    process.exit(2);
  }

  const table = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8'));
  const version = args.version || process.env.BG_CLI_VERSION || table.defaultVersion;
  const baseUrl = (
    args.baseUrl ||
    process.env.BG_DOWNLOAD_BASE_URL ||
    table.defaultDownloadBaseUrl
  ).replace(/\/+$/, '');

  const entry = table.versions[version];
  if (!entry) {
    console.error(`versions.json has no entry for ${version}`);
    process.exit(1);
  }

  console.log(`bg-deploy ${version} from ${baseUrl}\n`);

  const mismatches = [];
  const failures = [];

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
    console.log(`  ${mark} ${platform.padEnd(14)} ${result.sha256}  (${result.bytes} bytes)`);

    if (!matches) {
      mismatches.push({ platform, pinned: artifact.sha256, served: result.sha256 });
      if (args.mode === 'write') artifact.sha256 = result.sha256;
    }
  }

  if (args.mode === 'write') {
    entry.capturedFrom = `${baseUrl}/downloads/`;
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
    console.error(`\n${failures.length} platform(s) could not be checked.`);
    process.exit(1);
  }

  console.log('\nAll pinned checksums match.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
