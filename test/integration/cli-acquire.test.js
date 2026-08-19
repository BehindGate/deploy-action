'use strict';

/**
 * The unpinned download path, end to end against a local stand-in for the
 * download host: release index -> checksum manifest -> archive -> tool cache.
 *
 * The case worth the setup is a REPUBLISHED build. The test environment serves
 * a version more than once, and a tool cache keyed on the version alone would
 * keep handing back the build that was replaced -- silently, since a cache hit
 * looks exactly like a fast run. Nothing at the unit level can catch that,
 * because the cache is what has to be observed.
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { resolveHostArtifact, ChecksumNotListedError } = require('../../src/core/manifest');
const { cacheKey } = require('../../src/core/versions');
const { verifyFileChecksum, ChecksumMismatchError } = require('../../src/core/checksum');

const PLATFORM = 'linux-amd64';
const ARCHIVE = `bg-deploy-${PLATFORM}.tar.gz`;

let root = null;
let skipReason = null;

before(() => {
  if (process.platform === 'win32') {
    skipReason = 'the fixture archive is built with tar(1); not run on Windows';
    return;
  }
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-acquire-'));
});

after(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** A .tar.gz holding one fake bg-deploy, whose bytes differ per `body`. */
function makeArchive(body) {
  const stage = fs.mkdtempSync(path.join(root, 'stage-'));
  fs.writeFileSync(path.join(stage, 'bg-deploy'), `#!/bin/sh\necho ${body}\n`);

  const archive = path.join(stage, ARCHIVE);
  const tar = ['/usr/bin/tar', '/bin/tar'].find((candidate) => fs.existsSync(candidate));
  if (!tar) return null;

  execFileSync(tar, ['-czf', archive, '-C', stage, 'bg-deploy']);
  const bytes = fs.readFileSync(archive);
  return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

/**
 * A stand-in for the download host. `publish(version, body)` (re)publishes a
 * build, which is what the test environment does and production does not.
 */
function startDownloadHost() {
  const builds = new Map();
  const served = [];

  const server = http.createServer((req, res) => {
    served.push(req.url);
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };

    if (req.url === '/downloads/index.json') {
      const latest = [...builds.keys()].pop();
      return send(200, 'application/json', JSON.stringify({ latest, versions: [] }));
    }

    const manifest = /^\/downloads\/([^/]+)\/SHA256SUMS\.txt$/.exec(req.url);
    if (manifest) {
      const build = builds.get(manifest[1]);
      if (!build) return send(404, 'text/plain', 'no such version');
      return send(200, 'text/plain', `${build.sha256}  ${ARCHIVE}\n`);
    }

    const download = /^\/downloads\/([^/]+)\/(.+)$/.exec(req.url);
    if (download && builds.has(download[1]) && download[2] === ARCHIVE) {
      return send(200, 'application/gzip', builds.get(download[1]).bytes);
    }

    send(404, 'text/plain', 'not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        served,
        publish: (version, build) => builds.set(version, build),
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/** The fetcher src/index.js injects: plain global fetch, no @actions/* here. */
async function fetchText(url, what) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read the ${what} at ${url}: HTTP ${response.status}`);
  return response.text();
}

/** Download and verify exactly as the Action does, into a throwaway file. */
async function downloadAndVerify(host, artifact) {
  const url = `${host.url}/downloads/${artifact.version}/${artifact.archive}`;
  const response = await fetch(url);
  const file = path.join(fs.mkdtempSync(path.join(root, 'dl-')), artifact.archive);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));

  await verifyFileChecksum(file, artifact.sha256, { source: url });
  return file;
}

describe('acquiring an unpinned CLI from the host', () => {
  let host = null;

  beforeEach(async () => {
    if (host) await host.close();
    host = skipReason ? null : await startDownloadHost();
  });

  after(async () => {
    if (host) await host.close();
  });

  test('resolves the current version and verifies against the host manifest', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const build = makeArchive('first');
    if (!build) return t.skip('no tar(1) available to build the fixture');

    host.publish('2026.8.5', build);

    const artifact = await resolveHostArtifact({
      baseUrl: host.url,
      platform: PLATFORM,
      fetchText,
    });

    assert.equal(artifact.version, '2026.8.5');
    assert.equal(artifact.sha256, build.sha256);
    assert.equal(artifact.verifiedAgainst, `${host.url}/downloads/2026.8.5/SHA256SUMS.txt`);

    await downloadAndVerify(host, artifact);
  });

  test('a republished build changes the cache key, so the stale copy cannot be reused', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const first = makeArchive('first');
    if (!first) return t.skip('no tar(1) available to build the fixture');

    host.publish('2026.8.5', first);
    const before = await resolveHostArtifact({ baseUrl: host.url, platform: PLATFORM, fetchText });

    // Same version string, different bytes -- exactly what a rebuild looks like.
    const second = makeArchive('second');
    host.publish('2026.8.5', second);
    const after = await resolveHostArtifact({ baseUrl: host.url, platform: PLATFORM, fetchText });

    assert.equal(before.version, after.version, 'the version string is unchanged');
    assert.notEqual(before.sha256, after.sha256, 'the bytes moved');

    const beforeKey = cacheKey(before.version, before.sha256);
    const afterKey = cacheKey(after.version, after.sha256);
    assert.notEqual(beforeKey, afterKey, 'a version-only key would reuse the replaced build');
    assert.match(afterKey, /^2026\.8\.5-sha\.[0-9a-f]{12}$/);

    // And the new bytes verify against the new manifest, not the old digest.
    await downloadAndVerify(host, after);
    await assert.rejects(
      () => downloadAndVerify(host, { ...after, sha256: before.sha256 }),
      ChecksumMismatchError
    );
  });

  test('an unchanged build keeps its key, so the cache still hits', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const build = makeArchive('stable');
    if (!build) return t.skip('no tar(1) available to build the fixture');

    host.publish('2026.8.5', build);
    const first = await resolveHostArtifact({ baseUrl: host.url, platform: PLATFORM, fetchText });
    const second = await resolveHostArtifact({ baseUrl: host.url, platform: PLATFORM, fetchText });

    assert.equal(cacheKey(first.version, first.sha256), cacheKey(second.version, second.sha256));
  });

  test('a manifest that does not list this platform fails before anything runs', async (t) => {
    if (skipReason) return t.skip(skipReason);
    const build = makeArchive('first');
    if (!build) return t.skip('no tar(1) available to build the fixture');

    host.publish('2026.8.5', build);

    await assert.rejects(
      () => resolveHostArtifact({ baseUrl: host.url, platform: 'darwin-arm64', fetchText }),
      ChecksumNotListedError
    );
  });

  test('a version the host does not serve fails on its missing manifest', async (t) => {
    if (skipReason) return t.skip(skipReason);
    host.publish('2026.8.5', makeArchive('first') || { sha256: 'x', bytes: Buffer.alloc(0) });

    await assert.rejects(
      () =>
        resolveHostArtifact({
          baseUrl: host.url,
          platform: PLATFORM,
          version: '2026.9.9',
          fetchText,
        }),
      /HTTP 404/
    );
  });
});
