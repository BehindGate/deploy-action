'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// The semver the tool cache itself resolves, not whatever else is installed:
// what matters is how THAT copy treats the key, since it is the one that decides
// where a cached build lands.
const semver = require(
  require.resolve('semver', { paths: [require.resolve('@actions/tool-cache')] })
);

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

describe('artifactNames', () => {
  // The pin table carries these names per version; this derives them for a
  // version the table has never seen, which is the only way the test host's
  // newer builds can be fetched at all.
  test('matches every name the pin table records', () => {
    for (const version of versions.knownVersions()) {
      for (const platform of SUPPORTED) {
        const pinned = versions.resolveArtifact(version, platform);
        assert.deepEqual(
          versions.artifactNames(platform),
          { archive: pinned.archive, binary: pinned.binary },
          `${version} ${platform}: the convention has drifted from the table`
        );
      }
    }
  });

  test('windows gets a .zip and an .exe', () => {
    assert.deepEqual(versions.artifactNames('windows-arm64'), {
      archive: 'bg-deploy-windows-arm64.zip',
      binary: 'bg-deploy.exe',
    });
  });
});

describe('cacheKey', () => {
  // A version alone identifies a build only where a version is published once.
  // The test host republishes, so the digest has to be part of the key or the
  // cache serves the build that was replaced.
  test('carries the digest alongside the version', () => {
    assert.equal(
      versions.cacheKey('2026.8.5', 'e566ce5c86a774830e01501582c98540eef19a1f41d77416901761976b57b4b6'),
      '2026.8.5-sha.e566ce5c86a7'
    );
  });

  test('a republished build gets a different key', () => {
    const before = versions.cacheKey('2026.8.5', 'a'.repeat(64));
    const after = versions.cacheKey('2026.8.5', 'b'.repeat(64));
    assert.notEqual(before, after);
  });

  test('the digest survives semver normalisation, which build metadata does not', () => {
    // The tool cache runs whatever it is given through semver.clean, and that
    // DISCARDS build metadata (`2026.8.5+sha.abc` -> `2026.8.5`) while keeping a
    // prerelease. A key using `+` would collide with the plain version and hand
    // back the previous build, which is the whole failure being avoided.
    const key = versions.cacheKey('2026.8.5', 'a'.repeat(64));
    assert.ok(!key.includes('+'), 'the digest must not ride in build metadata');
    assert.equal(semver.clean(key), key, 'semver.clean must keep the digest');
    assert.notEqual(semver.clean(key), '2026.8.5');
  });

  test('normalises the vendor version the same way the pinned path does', () => {
    assert.equal(versions.cacheKey('2026.07.1', 'c'.repeat(64)), '2026.7.1-sha.cccccccccccc');
  });

  test('a build with no version is keyed on its digest alone', () => {
    // What the host serves at its unversioned path has no version until the CLI
    // reports one, so the digest is the whole identity.
    assert.equal(versions.cacheKey(null, 'e'.repeat(64)), '0.0.0-sha.eeeeeeeeeeee');
    assert.equal(versions.cacheKey('', 'e'.repeat(64)), '0.0.0-sha.eeeeeeeeeeee');
    assert.equal(versions.cacheKey(null, ''), null, 'nothing identifies it at all');
  });

  test('falls back to the bare version when no usable digest is given', () => {
    assert.equal(versions.cacheKey('2026.8.5', ''), '2026.8.5');
    assert.equal(versions.cacheKey('2026.8.5', 'not-a-digest'), '2026.8.5');
  });

  test('stays null for a version that cannot be normalised', () => {
    assert.equal(versions.cacheKey('nightly', 'a'.repeat(64)), null);
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

  test('every builder tolerates a run of trailing slashes', () => {
    // Stripped by a loop rather than by `\/+$`, whose backtracking is
    // super-linear in the number of slashes -- on a value that comes from a
    // workflow input.
    assert.equal(
      versions.withoutTrailingSlash('https://app.behindgate.com////'),
      'https://app.behindgate.com'
    );
    assert.equal(versions.withoutTrailingSlash('https://app.behindgate.com'), 'https://app.behindgate.com');
    assert.equal(versions.withoutTrailingSlash('///'), '');
    assert.equal(
      versions.downloadUrl('https://app.behindgate.com///', '2026.8.3', 'x.tar.gz'),
      'https://app.behindgate.com/downloads/2026.8.3/x.tar.gz'
    );
    assert.equal(
      versions.checksumsUrl('https://app.test.behindgate.net//', '2026.8.5'),
      'https://app.test.behindgate.net/downloads/2026.8.5/SHA256SUMS.txt'
    );
  });

  test('a version that could change the path is refused, not escaped', () => {
    // On an unpinned environment the version comes from the host's own index,
    // so it is remote data deciding which path the next request fetches.
    for (const version of ['../../elsewhere', 'a/b', '2026.8.5?x=1', '2026.8.5#f', '', ' ']) {
      assert.throws(
        () => versions.checksumsUrl('https://app.test.behindgate.net', version),
        versions.UnsafeVersionError,
        JSON.stringify(version)
      );
      assert.throws(
        () => versions.downloadUrl('https://app.test.behindgate.net', version, 'x.tar.gz'),
        versions.UnsafeVersionError
      );
    }
  });

  test('a real version passes through encoding unchanged', () => {
    // The accepted character set is one percent-encoding leaves alone, so the
    // check and the encoding cannot disagree about what the segment is.
    for (const version of ['2026.8.5', '2026.07.1-rc.1', '1.2.3_4~5']) {
      assert.equal(versions.versionSegment(version), version);
    }
  });

  test('the unversioned builders name what the host serves now', () => {
    assert.equal(
      versions.currentChecksumsUrl('https://app.test.behindgate.net/'),
      'https://app.test.behindgate.net/downloads/SHA256SUMS.txt'
    );
    assert.equal(
      versions.currentDownloadUrl('https://app.test.behindgate.net', 'bg-deploy-linux-amd64.tar.gz'),
      'https://app.test.behindgate.net/downloads/bg-deploy-linux-amd64.tar.gz'
    );
  });

  test('checksumsUrl points at the manifest beside that version', () => {
    assert.equal(
      versions.checksumsUrl('https://app.test.behindgate.net/', '2026.8.5'),
      'https://app.test.behindgate.net/downloads/2026.8.5/SHA256SUMS.txt'
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
