'use strict';

/**
 * SHA256 verification against the checksums committed in `versions.json`.
 *
 * Pure, dependency-free: node builtins only, no `@actions/*` imports.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

class ChecksumMismatchError extends Error {
  constructor({ file, expected, actual, source }) {
    super(
      `Checksum verification failed for ${file}.\n` +
        `  expected (pinned in versions.json): ${expected}\n` +
        `  actual   (downloaded${source ? ` from ${source}` : ''}): ${actual}\n` +
        `\n` +
        `The download does not match the hash this repository pins. Refusing to ` +
        `execute it. Either the host is serving a different build than the one ` +
        `pinned (a maintainer must re-capture and commit the new checksums), or ` +
        `the download was tampered with in transit.`
    );
    this.name = 'ChecksumMismatchError';
    this.file = file;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Stream a file through SHA256. Streaming rather than readFile so a large
 * archive never has to sit in memory on a small runner.
 *
 * @returns {Promise<string>} lowercase hex digest
 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Case-insensitive, length-safe comparison of two hex digests. */
function digestsEqual(a, b) {
  const left = Buffer.from(String(a).trim().toLowerCase(), 'utf8');
  const right = Buffer.from(String(b).trim().toLowerCase(), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verify a downloaded file against its pinned checksum.
 *
 * @throws {ChecksumMismatchError} when the digests differ
 * @returns {Promise<string>} the verified digest
 */
async function verifyFileChecksum(filePath, expected, { source } = {}) {
  const actual = await sha256File(filePath);

  if (!digestsEqual(actual, expected)) {
    throw new ChecksumMismatchError({ file: filePath, expected, actual, source });
  }

  return actual;
}

module.exports = {
  sha256File,
  digestsEqual,
  verifyFileChecksum,
  ChecksumMismatchError,
};
