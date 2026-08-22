'use strict';

/**
 * Runner platform resolution.
 *
 * Pure, dependency-free: no `@actions/*` imports, so Bitbucket Pipes can reuse
 * this unchanged.
 */

class UnsupportedPlatformError extends Error {
  constructor(nodePlatform, nodeArch, supported) {
    super(
      `bg-deploy has no published build for ${nodePlatform}/${nodeArch}. ` +
        `Supported platforms: ${supported.join(', ')}.`
    );
    this.name = 'UnsupportedPlatformError';
    this.nodePlatform = nodePlatform;
    this.nodeArch = nodeArch;
  }
}

/** Node's `process.platform` -> the vendor's OS token. */
const OS_BY_NODE_PLATFORM = {
  linux: 'linux',
  darwin: 'darwin',
  win32: 'windows',
};

/** Node's `process.arch` -> the vendor's arch token. */
const ARCH_BY_NODE_ARCH = {
  x64: 'amd64',
  arm64: 'arm64',
};

/**
 * Platforms the vendor actually publishes. Anything outside this set must fail
 * loudly rather than guess at an archive name that would 404 (or worse, 403 to
 * an SPA fallback that returns HTML with a 200).
 *
 * windows-arm64 was added upstream in 2026.8.x; before that it was the one
 * combination that resolved cleanly from the tables above but had no artifact.
 */
const SUPPORTED = Object.freeze([
  'linux-amd64',
  'linux-arm64',
  'darwin-amd64',
  'darwin-arm64',
  'windows-amd64',
  'windows-arm64',
]);

/**
 * Resolve a runner to a vendor platform key such as `linux-amd64`.
 *
 * @param {string} [nodePlatform] defaults to `process.platform`
 * @param {string} [nodeArch] defaults to `process.arch`
 * @returns {string}
 */
function resolvePlatform(nodePlatform = process.platform, nodeArch = process.arch) {
  const os = OS_BY_NODE_PLATFORM[nodePlatform];
  const arch = ARCH_BY_NODE_ARCH[nodeArch];

  if (!os || !arch) {
    throw new UnsupportedPlatformError(nodePlatform, nodeArch, SUPPORTED);
  }

  const key = `${os}-${arch}`;

  // Belt and braces: the tables above can resolve a combination the vendor does
  // not publish, and guessing an archive name is worse than failing.
  if (!SUPPORTED.includes(key)) {
    throw new UnsupportedPlatformError(nodePlatform, nodeArch, SUPPORTED);
  }

  return key;
}

module.exports = {
  resolvePlatform,
  UnsupportedPlatformError,
  SUPPORTED,
  OS_BY_NODE_PLATFORM,
  ARCH_BY_NODE_ARCH,
};
