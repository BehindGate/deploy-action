'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  EXIT_SUCCESS,
  EXIT_RUNTIME,
  EXIT_USAGE,
  describeExitCode,
} = require('../../src/core/errors');

describe('describeExitCode', () => {
  test('exit 0 is a success', () => {
    assert.match(describeExitCode(EXIT_SUCCESS).title, /succeeded/i);
  });

  test('exit 2 blames the invocation, and points at an empty secret first', () => {
    const { title, detail } = describeExitCode(EXIT_USAGE);
    assert.match(title, /invocation/i);
    assert.match(detail, /exit 2/);
    assert.match(detail, /usage error/i);
    // The Action builds argv itself, so the actionable cause is the secret.
    assert.match(detail, /empty/i);
    assert.match(detail, /secret/i);
    assert.match(detail, /fork/i);
  });

  test('exit 1 blames the run, and names the malformed-token case', () => {
    const { title, detail } = describeExitCode(EXIT_RUNTIME);
    assert.match(title, /failed/i);
    assert.match(detail, /exit 1/);
    assert.match(detail, /runtime failure/i);
    assert.match(detail, /not a JWT/);
    assert.match(detail, /expired|revoked/i);
  });

  // The whole point of requirement 5: these must not read the same.
  test('usage and runtime failures are distinguishable', () => {
    const usage = describeExitCode(EXIT_USAGE);
    const runtime = describeExitCode(EXIT_RUNTIME);
    assert.notEqual(usage.title, runtime.title);
    assert.notEqual(usage.detail, runtime.detail);
  });

  test('exit 2 mentions the path when one is supplied', () => {
    const { detail } = describeExitCode(EXIT_USAGE, { path: 'build/out' });
    assert.match(detail, /build\/out/);
  });

  test('exit 2 says so outright when the token was known to be empty', () => {
    const { detail } = describeExitCode(EXIT_USAGE, { tokenLooksEmpty: true });
    assert.match(detail, /was empty when this step started/);
  });

  test('an undocumented exit code is reported as unexpected, not silently mapped', () => {
    const { title, detail } = describeExitCode(137);
    assert.match(title, /unexpected/i);
    assert.match(detail, /137/);
  });
});
