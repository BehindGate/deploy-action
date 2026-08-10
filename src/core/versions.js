'use strict';

/**
 * Lookups against the committed `versions.json` pin table.
 *
 * Pure, dependency-free: no `@actions/*` imports. The table is passed in (with
 * the bundled one as the default) so tests and other CI integrations can
 * substitute their own without touching the filesystem.
 */

const DEFAULT_TABLE = require('../../versions.json');

class UnknownVersionError extends Error {
  constructor(version, known) {
    super(
      `No pinned checksums for bg-deploy version "${version}". ` +
        `Known versions: ${known.join(', ')}. ` +
        `Add the version to versions.json before using it -- an unpinned ` +
        `version cannot be verified against anything this repo controls.`
    );
    this.name = 'UnknownVersionError';
    this.version = version;
  }
}

class UnknownPlatformError extends Error {
  constructor(version, platform, known) {
    super(
      `versions.json has no "${platform}" entry for bg-deploy ${version}. ` +
        `Platforms pinned for this version: ${known.join(', ')}.`
    );
    this.name = 'UnknownPlatformError';
    this.version = version;
    this.platform = platform;
  }
}

/** The version used when the caller does not pin one. */
function defaultVersion(table = DEFAULT_TABLE) {
  return table.defaultVersion;
}

/** The download host used when the caller does not supply one. */
function defaultDownloadBaseUrl(table = DEFAULT_TABLE) {
  return table.defaultDownloadBaseUrl;
}

function knownVersions(table = DEFAULT_TABLE) {
  return Object.keys(table.versions);
}

/**
 * Resolve the pinned artifact for a version/platform pair.
 *
 * @returns {{version: string, platform: string, archive: string, binary: string, sha256: string, capturedFrom: string|undefined}}
 */
function resolveArtifact(version, platform, table = DEFAULT_TABLE) {
  const entry = table.versions[version];
  if (!entry) {
    throw new UnknownVersionError(version, knownVersions(table));
  }

  const artifact = entry.platforms[platform];
  if (!artifact) {
    throw new UnknownPlatformError(version, platform, Object.keys(entry.platforms));
  }

  return {
    version,
    platform,
    archive: artifact.archive,
    binary: artifact.binary,
    sha256: artifact.sha256,
    capturedFrom: entry.capturedFrom,
  };
}

/**
 * Normalise a CLI version string into valid semver, or null if it cannot be.
 *
 * This exists because tool caches key on semver, and BehindGate's version
 * strings are not valid semver: `2026.07.1` has a leading zero in the minor
 * component, which semver rejects. Left alone, a cache lookup for `2026.07.1`
 * is treated as a *range* rather than an exact version, matches nothing, and
 * the CLI is re-downloaded on every single run -- silently, since a cache miss
 * looks identical to a cold start.
 *
 * Both the store and the lookup must use the same normalised value.
 */
function semverSafeVersion(version) {
  const raw = String(version ?? '').trim();
  if (!raw) return null;

  const [core, ...suffix] = raw.split('-');
  const parts = core.split('.');

  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
  while (parts.length < 3) parts.push('0');

  const normalized = parts.map((part) => String(parseInt(part, 10))).join('.');
  return suffix.length ? `${normalized}-${suffix.join('-')}` : normalized;
}

/**
 * Build the download URL for an archive.
 *
 * Versioned and immutable: `/downloads/<version>/<archive>`. Until 2026.8.x the
 * published paths carried no version, which meant a pinned checksum was a
 * pin against a moving target -- the host could serve different bytes under the
 * same name at any time. Requesting the version by name makes `cli-version` an
 * actual pin, and makes rollback to a previous release possible.
 *
 * The base URL is a parameter rather than a constant because BehindGate serves
 * downloads from a different host per environment (production and test are not
 * the same host), so hardcoding one would break every non-production user.
 */
function downloadUrl(baseUrl, version, archive) {
  const trimmed = String(baseUrl).replace(/\/+$/, '');
  return `${trimmed}/downloads/${version}/${archive}`;
}

/** URL of the published release index (`{latest, versions: [...]}`). */
function indexUrl(baseUrl) {
  return `${String(baseUrl).replace(/\/+$/, '')}/downloads/index.json`;
}

module.exports = {
  DEFAULT_TABLE,
  defaultVersion,
  defaultDownloadBaseUrl,
  knownVersions,
  resolveArtifact,
  semverSafeVersion,
  downloadUrl,
  indexUrl,
  UnknownVersionError,
  UnknownPlatformError,
};
