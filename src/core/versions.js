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
 * The archive and binary names for a platform, by the vendor's convention.
 *
 * `resolveArtifact` reads these from the pin table, which is the right answer
 * whenever the version is pinned. This derives them instead, for the one case
 * that has no entry to read: a host serving a build newer than anything
 * committed here. A unit test holds the convention to every pinned entry, so a
 * rename upstream fails here rather than as a 404 mid-deploy.
 */
function artifactNames(platform) {
  const windows = String(platform).startsWith('windows-');
  return {
    archive: `bg-deploy-${platform}.${windows ? 'zip' : 'tar.gz'}`,
    binary: windows ? 'bg-deploy.exe' : 'bg-deploy',
  };
}

/**
 * Normalise a vendor version string into valid semver, or null if it cannot be.
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
 * Drop any trailing slashes from a base URL.
 *
 * A loop rather than `replace(/\/+$/, '')`: the regex form backtracks, so its
 * runtime grows super-linearly with a long run of slashes, and these base URLs
 * come from a workflow input. The result is identical and the cost is not.
 */
function withoutTrailingSlash(value) {
  const text = String(value);

  let end = text.length;
  while (end > 0 && text.charAt(end - 1) === '/') end -= 1;

  return text.slice(0, end);
}

/**
 * Build the download URL for an archive.
 *
 * Versioned and immutable: `/downloads/<version>/<archive>`. Until 2026.8.x the
 * vendor published only unversioned paths, which meant a pinned checksum was a
 * pin against a moving target -- the host could serve different bytes under the
 * same name at any time. Requesting the version by name makes `cli-version` an
 * actual pin, and makes rollback to a previous release possible.
 *
 * The base URL is a parameter rather than a constant because BehindGate serves
 * downloads from a different host per environment (production and test are not
 * the same host), so hardcoding one would break every non-production user.
 */
function downloadUrl(baseUrl, version, archive) {
  return `${withoutTrailingSlash(baseUrl)}/downloads/${version}/${archive}`;
}

/** URL of the published release index (`{latest, versions: [...]}`). */
function indexUrl(baseUrl) {
  return `${withoutTrailingSlash(baseUrl)}/downloads/index.json`;
}

/** URL of the checksum manifest a host serves beside one version's archives. */
function checksumsUrl(baseUrl, version) {
  return `${withoutTrailingSlash(baseUrl)}/downloads/${version}/SHA256SUMS.txt`;
}

/**
 * The tool-cache key for a build, as version plus the digest that identifies it.
 *
 * A version alone is enough where a version is published once and never again.
 * It is not enough on a host that republishes: the cache would hand back the
 * previous build under the same key, and the run would silently use bytes the
 * host has since replaced -- the one thing re-downloading was supposed to catch.
 *
 * The digest goes in a PRERELEASE segment rather than semver build metadata:
 * `semver.clean`, which the tool cache applies to whatever it is given, keeps a
 * prerelease and discards build metadata. `2026.8.5+sha.abc` would land in the
 * same cache entry as `2026.8.5`, which is exactly the collision being avoided.
 *
 * @returns {string|null} null when the version cannot be normalised, as before
 */
function cacheKey(version, sha256) {
  const normalized = semverSafeVersion(version);
  if (!normalized) return null;

  const digest = String(sha256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{12,}$/.test(digest)) return normalized;

  return `${normalized}-sha.${digest.slice(0, 12)}`;
}

module.exports = {
  DEFAULT_TABLE,
  defaultVersion,
  defaultDownloadBaseUrl,
  knownVersions,
  resolveArtifact,
  artifactNames,
  semverSafeVersion,
  cacheKey,
  withoutTrailingSlash,
  downloadUrl,
  indexUrl,
  checksumsUrl,
  UnknownVersionError,
  UnknownPlatformError,
};
