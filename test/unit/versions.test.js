'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const versions = require('../../src/core/versions');
const { SUPPORTED } = require('../../src/core/platform');

describe('versions table', () => {
  test('the default version is present in the table', () => {
    assert.ok(versions.knownVersions().includes(versions.defaultVersion()));
  });

  test('every supported platform is pinned for the default version', () => {
    // Guards against the table drifting away from what the Action can resolve:
    // a runner that resolves to a platform with no pinned checksum would fail
    // at deploy time rather than here.
    for (const platform of SUPPORTED) {
      const artifact = versions.resolveArtifact(versions.defaultVersion(), platform);
      assert.equal(artifact.platform, platform);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/, `${platform} needs a full SHA256`);
      assert.ok(artifact.archive.includes(platform), `${platform} archive name mismatch`);
    }
  });

  test('windows pins the .exe and a .zip archive, others a bare binary and .tar.gz', () => {
    const win = versions.resolveArtifact(versions.defaultVersion(), 'windows-amd64');
    assert.equal(win.binary, 'bg-deploy.exe');
    assert.ok(win.archive.endsWith('.zip'));

    const linux = versions.resolveArtifact(versions.defaultVersion(), 'linux-amd64');
    assert.equal(linux.binary, 'bg-deploy');
    assert.ok(linux.archive.endsWith('.tar.gz'));
  });

  test('checksums are unique per platform', () => {
    const seen = new Set();
    for (const platform of SUPPORTED) {
      const { sha256 } = versions.resolveArtifact(versions.defaultVersion(), platform);
      assert.ok(!seen.has(sha256), `duplicate checksum for ${platform} -- likely a copy/paste error`);
      seen.add(sha256);
    }
  });

  test('an unpinned version is refused rather than downloaded unverified', () => {
    assert.throws(
      () => versions.resolveArtifact('1999.01.1', 'linux-amd64'),
      versions.UnknownVersionError
    );
  });

  test('an unpinned platform is refused', () => {
    assert.throws(
      () => versions.resolveArtifact(versions.defaultVersion(), 'plan9-amd64'),
      versions.UnknownPlatformError
    );
  });
});

describe('semverSafeVersion', () => {
  // Regression guard. The vendor's own format has a leading zero in the minor
  // component, which is not valid semver. Passing it straight to the tool cache
  // turns an exact lookup into a range match, which never hits -- so the CLI is
  // re-downloaded on every run and the caching requirement is quietly defeated.
  test('normalises the vendor format by stripping leading zeros', () => {
    assert.equal(versions.semverSafeVersion('2026.07.1'), '2026.7.1');
    assert.equal(versions.semverSafeVersion('2026.01.09'), '2026.1.9');
  });

  test('the current default version normalises to valid semver', () => {
    const normalized = versions.semverSafeVersion(versions.defaultVersion());
    assert.ok(normalized, 'the default version must be cacheable');
    assert.match(normalized, /^\d+\.\d+\.\d+$/);
  });

  test('leaves an already-valid version untouched', () => {
    assert.equal(versions.semverSafeVersion('1.2.3'), '1.2.3');
  });

  test('pads a short version to three components', () => {
    assert.equal(versions.semverSafeVersion('2026.7'), '2026.7.0');
    assert.equal(versions.semverSafeVersion('3'), '3.0.0');
  });

  test('preserves a prerelease suffix', () => {
    assert.equal(versions.semverSafeVersion('2026.07.1-rc.1'), '2026.7.1-rc.1');
  });

  test('returns null rather than guessing at an unnormalisable version', () => {
    // Callers fall back to running uncached, which is slow but still correct.
    assert.equal(versions.semverSafeVersion('2026.07.1.4'), null);
    assert.equal(versions.semverSafeVersion('nightly'), null);
    assert.equal(versions.semverSafeVersion(''), null);
    assert.equal(versions.semverSafeVersion(undefined), null);
  });
});

describe('downloadUrl', () => {
  // Versioned paths are what make cli-version a real pin rather than an
  // assertion about whatever the host currently serves.
  test('requests the version by name', () => {
    assert.equal(
      versions.downloadUrl('https://app.behindgate.com', '2026.8.3', 'bg-deploy-linux-amd64.tar.gz'),
      'https://app.behindgate.com/downloads/2026.8.3/bg-deploy-linux-amd64.tar.gz'
    );
  });

  test('tolerates a trailing slash', () => {
    assert.equal(
      versions.downloadUrl('https://app.behindgate.com/', '2026.8.3', 'x.tar.gz'),
      'https://app.behindgate.com/downloads/2026.8.3/x.tar.gz'
    );
  });

  test('honours a non-production host', () => {
    // Hosts are per-environment; nothing may hardcode production.
    assert.equal(
      versions.downloadUrl('https://app.test.behindgate.net', '2026.8.3', 'x.tar.gz'),
      'https://app.test.behindgate.net/downloads/2026.8.3/x.tar.gz'
    );
  });

  test('indexUrl points at the release index', () => {
    assert.equal(
      versions.indexUrl('https://app.behindgate.com/'),
      'https://app.behindgate.com/downloads/index.json'
    );
  });
});

describe('minimum supported CLI version', () => {
  // The Action reads --json, which does not exist before 2026.8.0, and earlier
  // releases used a different exit-code scheme. A pre-2026.8.0 entry would
  // install cleanly and then fail at runtime.
  test('no pinned version predates the --json contract', () => {
    for (const version of versions.knownVersions()) {
      const normalized = versions.semverSafeVersion(version);
      assert.ok(normalized, `${version} must be semver-normalisable`);
      const [major, minor] = normalized.split('.').map(Number);
      assert.ok(
        major > 2026 || (major === 2026 && minor >= 8),
        `${version} predates 2026.8.0 and does not support --json`
      );
    }
  });
});
