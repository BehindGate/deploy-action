'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolvePlatform, UnsupportedPlatformError, SUPPORTED } = require('../../src/core/platform');

describe('resolvePlatform', () => {
  const cases = [
    ['linux', 'x64', 'linux-amd64'],
    ['linux', 'arm64', 'linux-arm64'],
    ['darwin', 'x64', 'darwin-amd64'],
    ['darwin', 'arm64', 'darwin-arm64'],
    ['win32', 'x64', 'windows-amd64'],
  ];

  for (const [nodePlatform, nodeArch, expected] of cases) {
    test(`${nodePlatform}/${nodeArch} -> ${expected}`, () => {
      assert.equal(resolvePlatform(nodePlatform, nodeArch), expected);
    });
  }

  test('every resolvable platform is in the supported list', () => {
    for (const [nodePlatform, nodeArch] of cases) {
      assert.ok(SUPPORTED.includes(resolvePlatform(nodePlatform, nodeArch)));
    }
  });

  test('rejects windows-arm64, which resolves but is not published', () => {
    // This is the case a naive lookup table gets wrong: the tokens map cleanly
    // to "windows-arm64", but the vendor publishes no such archive.
    assert.throws(() => resolvePlatform('win32', 'arm64'), UnsupportedPlatformError);
  });

  test('rejects an unknown OS', () => {
    assert.throws(() => resolvePlatform('freebsd', 'x64'), UnsupportedPlatformError);
  });

  test('rejects a 32-bit runner', () => {
    assert.throws(() => resolvePlatform('linux', 'ia32'), UnsupportedPlatformError);
  });

  test('the error names the platform and lists what is supported', () => {
    try {
      resolvePlatform('freebsd', 'riscv64');
      assert.fail('should have thrown');
    } catch (error) {
      assert.match(error.message, /freebsd\/riscv64/);
      assert.match(error.message, /linux-amd64/);
    }
  });

  test('defaults to the current process when called with no arguments', () => {
    assert.equal(resolvePlatform(), resolvePlatform(process.platform, process.arch));
  });
});
