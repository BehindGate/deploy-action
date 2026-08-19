'use strict';

/**
 * Parsing of what the download host publishes about its own builds: the
 * release index and the SHA256SUMS.txt served beside each version.
 *
 * Pure, dependency-free: no `@actions/*` imports and no network access. The
 * caller fetches; this only reads.
 *
 * WHAT THIS IS AND IS NOT. A checksum served by the same host as the binary it
 * describes proves only that the download arrived intact -- anyone able to serve
 * a modified binary can serve a matching line beside it. That is exactly why
 * `versions.json` exists and why production verifies against it instead.
 *
 * This is for the test environment, whose builds are republished often enough
 * that a committed pin describes them for hours at a time. The choice there is
 * not "pinned or host-served"; it is "host-served or nothing", and a truncated
 * or half-published archive is the failure that actually happens.
 */

const versions = require('./versions');

/** ` at <source>`, or nothing. Kept out of the messages so they stay readable. */
function at(source) {
  return source ? ` at ${source}` : '';
}

class MalformedChecksumsError extends Error {
  constructor(source) {
    super(
      `Could not read any checksum from the manifest${at(source)}. ` +
        `Expected lines of "<64 hex digits>  <filename>". Refusing to run a ` +
        `download that nothing describes.`
    );
    this.name = 'MalformedChecksumsError';
  }
}

class ChecksumNotListedError extends Error {
  constructor(archive, listed, source) {
    super(
      `The manifest${at(source)} has no entry for ${archive}. ` +
        `It lists: ${listed.join(', ') || '(nothing)'}. ` +
        `The host is serving a build for this platform that it does not describe, ` +
        `so there is nothing to verify the download against.`
    );
    this.name = 'ChecksumNotListedError';
    this.archive = archive;
  }
}

/** One `<digest>  <name>` line, in the format sha256sum(1) writes. */
const LINE = /^([0-9a-f]{64})\s+\*?(\S+)$/i;

/**
 * Parse a SHA256SUMS.txt into `{ filename: digest }`.
 *
 * Unreadable lines are skipped rather than fatal -- a comment or a trailing
 * blank line should not cost the whole manifest -- but a file that yields no
 * entries at all is an error, since that is what an HTML error page served with
 * a 200 looks like.
 *
 * @throws {MalformedChecksumsError}
 */
function parseChecksums(text, { source } = {}) {
  const entries = {};

  for (const line of String(text ?? '').split('\n')) {
    const match = LINE.exec(line.trim());
    if (match) entries[match[2]] = match[1].toLowerCase();
  }

  if (!Object.keys(entries).length) throw new MalformedChecksumsError(source);

  return entries;
}

/**
 * The digest a manifest gives for one archive.
 *
 * @throws {MalformedChecksumsError|ChecksumNotListedError}
 * @returns {string} lowercase hex digest
 */
function checksumFor(text, archive, { source } = {}) {
  const entries = parseChecksums(text, { source });
  const digest = entries[archive];

  if (!digest) {
    throw new ChecksumNotListedError(archive, Object.keys(entries), source);
  }

  return digest;
}

/**
 * Resolve, from the host itself, which build to download and the digest to hold
 * it to.
 *
 * `fetchText(url, what)` is injected rather than imported so this module stays
 * free of any transport of its own, and so a test can point it at a local
 * server without a network.
 *
 * @returns {Promise<{version: string, platform: string, archive: string, binary: string, sha256: string, verifiedAgainst: string}>}
 */
async function resolveHostArtifact({ baseUrl, platform, version, fetchText }) {
  const requested = String(version ?? '').trim();
  const names = versions.artifactNames(platform);

  // Without a requested version, both URLs are the host's unversioned ones:
  // "whatever you are serving now". That is the only question worth asking an
  // environment that republishes, and it keeps every URL built from constants --
  // no document the host serves gets to decide which URL is fetched next.
  const source = requested
    ? versions.checksumsUrl(baseUrl, requested)
    : versions.currentChecksumsUrl(baseUrl);

  const sha256 = checksumFor(await fetchText(source, 'checksum manifest'), names.archive, {
    source,
  });

  return {
    // Null where the build is the host's current one: it has no version until
    // the CLI reports its own, and the digest below is what identifies it.
    version: requested || null,
    platform,
    archive: names.archive,
    binary: names.binary,
    sha256,
    downloadUrl: requested
      ? versions.downloadUrl(baseUrl, requested, names.archive)
      : versions.currentDownloadUrl(baseUrl, names.archive),
    verifiedAgainst: source,
  };
}

module.exports = {
  parseChecksums,
  checksumFor,
  resolveHostArtifact,
  MalformedChecksumsError,
  ChecksumNotListedError,
};
