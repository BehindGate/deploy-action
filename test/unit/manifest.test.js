'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseChecksums,
  checksumFor,
  latestVersion,
  resolveHostArtifact,
  MalformedChecksumsError,
  ChecksumNotListedError,
} = require('../../src/core/manifest');

/** Verbatim SHA256SUMS.txt from the test host for bg-deploy 2026.8.5. */
const MANIFEST = [
  '6cce35af0b26277d77c63aea646c9853590da85f776c40c387a81acc90e5f2cf  bg-deploy-darwin-amd64.tar.gz',
  '6cf59b353a11cd0f94ef2b947a12c98e8963df72fdf0f564df0c5c4e519eccc2  bg-deploy-darwin-arm64.tar.gz',
  'e566ce5c86a774830e01501582c98540eef19a1f41d77416901761976b57b4b6  bg-deploy-linux-amd64.tar.gz',
  '657bc228b13c64b6bb89104ea9b63c08cf31625e60d9453ae365ccb9f12ae684  bg-deploy-linux-arm64.tar.gz',
  '7ca915e29a548f2761c7b2d7cbd54251706b836d3fa12cc5a7cfd0e4933dde29  bg-deploy-windows-amd64.zip',
  'aa02798f49c4fbb472aa40528af312440948f84573f997225ec8033dc11f8820  bg-deploy-windows-arm64.zip',
  '',
].join('\n');

describe('parseChecksums', () => {
  test('reads every entry from a real manifest', () => {
    const entries = parseChecksums(MANIFEST);
    assert.equal(Object.keys(entries).length, 6);
    assert.equal(
      entries['bg-deploy-linux-amd64.tar.gz'],
      'e566ce5c86a774830e01501582c98540eef19a1f41d77416901761976b57b4b6'
    );
  });

  test('tolerates the binary-mode asterisk and upper-case digests', () => {
    const entries = parseChecksums(`${'A'.repeat(64)} *bg-deploy-linux-amd64.tar.gz`);
    assert.equal(entries['bg-deploy-linux-amd64.tar.gz'], 'a'.repeat(64));
  });

  test('skips a line it cannot read rather than losing the manifest', () => {
    const entries = parseChecksums(`# a comment\n\n${MANIFEST}`);
    assert.equal(Object.keys(entries).length, 6);
  });

  test('a manifest with no entries is an error, not an empty result', () => {
    // This is what an HTML error page served with a 200 looks like, and it must
    // not read as "nothing to verify against, carry on".
    assert.throws(() => parseChecksums('<!doctype html><h1>404</h1>'), MalformedChecksumsError);
    assert.throws(() => parseChecksums(''), MalformedChecksumsError);
  });

  test('a digest that is not 64 hex characters is not an entry', () => {
    assert.throws(() => parseChecksums('deadbeef  bg-deploy-linux-amd64.tar.gz'), MalformedChecksumsError);
  });
});

describe('checksumFor', () => {
  test('returns the digest for one archive', () => {
    assert.equal(
      checksumFor(MANIFEST, 'bg-deploy-windows-arm64.zip'),
      'aa02798f49c4fbb472aa40528af312440948f84573f997225ec8033dc11f8820'
    );
  });

  test('an archive the manifest does not list is an error', () => {
    // The host is serving a platform build it does not describe; there is
    // nothing to verify the download against, so it must not be run.
    assert.throws(
      () => checksumFor(MANIFEST, 'bg-deploy-plan9-amd64.tar.gz'),
      (error) => {
        assert.ok(error instanceof ChecksumNotListedError);
        assert.match(error.message, /bg-deploy-linux-amd64\.tar\.gz/);
        return true;
      }
    );
  });
});

describe('latestVersion', () => {
  test('reads the version the host calls current', () => {
    assert.equal(latestVersion('{"latest":"2026.8.5","versions":[]}'), '2026.8.5');
    assert.equal(latestVersion({ latest: '2026.8.5' }), '2026.8.5');
  });

  test('an index with no latest is an error rather than an empty version', () => {
    // An empty version would build /downloads//bg-deploy-... and 404 later.
    assert.throws(() => latestVersion('{"versions":[]}'), /does not report a "latest"/);
    assert.throws(() => latestVersion('not json'), /does not report a "latest"/);
  });
});

describe('resolveHostArtifact', () => {
  /** Stand-in for the host: records what was asked for, answers from a table. */
  function fetcher(documents) {
    const asked = [];
    const fetchText = async (url) => {
      asked.push(url);
      if (!(url in documents)) throw new Error(`unexpected fetch of ${url}`);
      return documents[url];
    };
    return { fetchText, asked };
  }

  const BASE = 'https://app.test.behindgate.net';

  test('takes the version from the index and the digest from that version manifest', async () => {
    const { fetchText, asked } = fetcher({
      [`${BASE}/downloads/index.json`]: '{"latest":"2026.8.5"}',
      [`${BASE}/downloads/2026.8.5/SHA256SUMS.txt`]: MANIFEST,
    });

    const artifact = await resolveHostArtifact({
      baseUrl: BASE,
      platform: 'linux-amd64',
      fetchText,
    });

    assert.deepEqual(artifact, {
      version: '2026.8.5',
      platform: 'linux-amd64',
      archive: 'bg-deploy-linux-amd64.tar.gz',
      binary: 'bg-deploy',
      sha256: 'e566ce5c86a774830e01501582c98540eef19a1f41d77416901761976b57b4b6',
      verifiedAgainst: `${BASE}/downloads/2026.8.5/SHA256SUMS.txt`,
    });
    assert.deepEqual(asked, [
      `${BASE}/downloads/index.json`,
      `${BASE}/downloads/2026.8.5/SHA256SUMS.txt`,
    ]);
  });

  test('an explicit version wins, and the index is not even consulted', async () => {
    const { fetchText, asked } = fetcher({
      [`${BASE}/downloads/2026.8.4/SHA256SUMS.txt`]: MANIFEST,
    });

    const artifact = await resolveHostArtifact({
      baseUrl: BASE,
      platform: 'windows-amd64',
      version: '2026.8.4',
      fetchText,
    });

    assert.equal(artifact.version, '2026.8.4');
    assert.equal(artifact.binary, 'bg-deploy.exe');
    assert.equal(artifact.archive, 'bg-deploy-windows-amd64.zip');
    assert.deepEqual(asked, [`${BASE}/downloads/2026.8.4/SHA256SUMS.txt`]);
  });

  test('a republished build resolves to a different digest, and nothing else changes', async () => {
    // The whole reason this path exists: the version string stays put while the
    // bytes behind it move.
    const rebuilt = MANIFEST.replace(
      'e566ce5c86a774830e01501582c98540eef19a1f41d77416901761976b57b4b6',
      'f'.repeat(64)
    );
    const { fetchText } = fetcher({
      [`${BASE}/downloads/index.json`]: '{"latest":"2026.8.5"}',
      [`${BASE}/downloads/2026.8.5/SHA256SUMS.txt`]: rebuilt,
    });

    const artifact = await resolveHostArtifact({
      baseUrl: BASE,
      platform: 'linux-amd64',
      fetchText,
    });

    assert.equal(artifact.version, '2026.8.5');
    assert.equal(artifact.sha256, 'f'.repeat(64));
  });
});
