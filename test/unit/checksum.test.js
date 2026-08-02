'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sha256File,
  digestsEqual,
  verifyFileChecksum,
  ChecksumMismatchError,
} = require('../../src/core/checksum');

const CONTENT = 'behindgate';

// A well-formed digest that is NOT the digest of CONTENT: stands in for the
// hash an attacker-substituted archive would produce.
const WRONG_SHA256 = '7c8a4f0b8f2f5f8f6c3f1e6d9d4b6d5e0e9a1f6a2c3d4e5f60718293a4b5c6d7';

describe('checksum', () => {
  let dir;
  let file;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-checksum-'));
    file = path.join(dir, 'artifact.bin');
    fs.writeFileSync(file, CONTENT);
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('sha256File produces a 64-char lowercase hex digest', async () => {
    const digest = await sha256File(file);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  test('sha256File is stable across calls', async () => {
    assert.equal(await sha256File(file), await sha256File(file));
  });

  test('sha256File differs when a single byte changes', async () => {
    const other = path.join(dir, 'other.bin');
    fs.writeFileSync(other, `${CONTENT}!`);
    assert.notEqual(await sha256File(file), await sha256File(other));
  });

  test('verifyFileChecksum accepts a matching digest', async () => {
    const digest = await sha256File(file);
    assert.equal(await verifyFileChecksum(file, digest), digest);
  });

  test('verifyFileChecksum is case-insensitive', async () => {
    const digest = await sha256File(file);
    await verifyFileChecksum(file, digest.toUpperCase());
  });

  test('verifyFileChecksum tolerates surrounding whitespace', async () => {
    const digest = await sha256File(file);
    await verifyFileChecksum(file, `  ${digest}\n`);
  });

  // The path that actually matters: a substituted binary must not run.
  test('verifyFileChecksum throws on a mismatch', async () => {
    await assert.rejects(
      () => verifyFileChecksum(file, WRONG_SHA256),
      ChecksumMismatchError
    );
  });

  test('the mismatch error reports both digests and refuses to execute', async () => {
    const actual = await sha256File(file);
    try {
      await verifyFileChecksum(file, WRONG_SHA256, { source: 'https://example.test/x' });
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof ChecksumMismatchError);
      assert.equal(error.expected, WRONG_SHA256);
      assert.equal(error.actual, actual);
      assert.match(error.message, /Refusing to execute it/);
      assert.match(error.message, /https:\/\/example\.test\/x/);
    }
  });

  test('a truncated digest never compares equal', () => {
    assert.equal(digestsEqual('abc', 'abcd'), false);
    assert.equal(digestsEqual('', 'a'), false);
  });

  test('digestsEqual matches identical digests regardless of case', () => {
    assert.equal(digestsEqual('AbCd', 'abcd'), true);
  });
});
