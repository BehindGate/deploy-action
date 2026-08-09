'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  EXIT_SUCCESS,
  EXIT_RUNTIME,
  EXIT_CONFIG,
  EXIT_USAGE,
  describeExitCode,
} = require('../../src/core/errors');

describe('describeExitCode', () => {
  test('exit 0 is a success', () => {
    assert.match(describeExitCode(EXIT_SUCCESS).title, /succeeded/i);
  });

  test('exit 2 is reported as a configuration error', () => {
    const { title, detail } = describeExitCode(EXIT_CONFIG);
    assert.match(title, /configuration/i);
    assert.match(detail, /exit 2/);
  });

  // With `url` pinned, the CLI refuses to deploy when the token claims a
  // different endpoint. Since this Action already validates the token format
  // and the path itself, that refusal is the most likely remaining cause of a 2.
  test('exit 2 with a pinned url leads with the endpoint mismatch', () => {
    const { detail } = describeExitCode(EXIT_CONFIG, { urlPinned: true });
    assert.match(detail, /`url` input does not match/);
    assert.match(detail, /swapped secret/);
    assert.match(detail, /test-environment token cannot deploy to production/);
  });

  test('exit 2 without a pinned url points at the secret instead', () => {
    const { detail } = describeExitCode(EXIT_CONFIG, { urlPinned: false });
    assert.match(detail, /empty string/);
    assert.match(detail, /fork/);
    assert.doesNotMatch(detail, /`url` input does not match/);
  });

  test('exit 1 is reported as a runtime failure, not a config problem', () => {
    const { title, detail } = describeExitCode(EXIT_RUNTIME);
    assert.match(title, /failed/i);
    assert.match(detail, /exit 1/);
    assert.match(detail, /runtime failure/i);
    assert.match(detail, /transient/);
  });

  // Requirement: the two classes must not read the same.
  test('configuration and runtime failures are distinguishable', () => {
    const config = describeExitCode(EXIT_CONFIG);
    const runtime = describeExitCode(EXIT_RUNTIME);
    assert.notEqual(config.title, runtime.title);
    assert.notEqual(config.detail, runtime.detail);
  });

  test("the CLI's own message is surfaced when available", () => {
    const { detail } = describeExitCode(EXIT_CONFIG, { cliMessage: 'not a JWT (not_a_jwt)' });
    assert.match(detail, /bg-deploy reported: not a JWT \(not_a_jwt\)/);
  });

  test('exit 2 mentions the path when one is supplied', () => {
    const { detail } = describeExitCode(EXIT_CONFIG, { path: 'build/out' });
    assert.match(detail, /build\/out/);
  });

  test('an undocumented exit code is reported as unexpected, not silently mapped', () => {
    const { title, detail } = describeExitCode(137);
    assert.match(title, /unexpected/i);
    assert.match(detail, /137/);
  });

  test('EXIT_USAGE is retained as an alias of EXIT_CONFIG', () => {
    // 2026.8.x folded malformed credentials (previously exit 1) into exit 2, so
    // the code no longer means "usage" specifically.
    assert.equal(EXIT_USAGE, EXIT_CONFIG);
    assert.equal(EXIT_CONFIG, 2);
  });
});
