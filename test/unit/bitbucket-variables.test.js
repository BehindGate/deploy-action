'use strict';

/**
 * Pipe variable resolution.
 *
 * Exercised in-process because the interesting case cannot be reached from a
 * subprocess: it involves setting PATH to something that is not a search path,
 * which would stop the subprocess finding node in the first place.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { resolveDeployPath, resolveToken, PipeError } = require('../../src/bitbucket/index');

const original = { ...process.env };

afterEach(() => {
  for (const key of ['DEPLOY_PATH', 'BEHINDGATE_TOKEN', 'PATH']) {
    if (key in original) process.env[key] = original[key];
    else delete process.env[key];
  }
});

describe('the deploy path variable', () => {
  test('is read from DEPLOY_PATH and trimmed', () => {
    process.env.DEPLOY_PATH = '  dist  ';
    assert.equal(resolveDeployPath(), 'dist');
  });

  test('names the variable and shows the block to copy when it is empty', () => {
    process.env.DEPLOY_PATH = '';
    assert.throws(() => resolveDeployPath(), (error) => {
      assert.ok(error instanceof PipeError);
      assert.match(error.message, /DEPLOY_PATH is empty/);
      assert.match(error.message, /DEPLOY_PATH: dist/);
      return true;
    });
  });

  test('catches a build directory passed as PATH', () => {
    // Bitbucket injects pipe variables as environment variables, so `PATH: dist`
    // replaces the container's executable search path. Every command in the job
    // then fails for reasons that have nothing to do with what went wrong, so
    // this guesses the intent and says so.
    process.env.DEPLOY_PATH = '';
    process.env.PATH = 'dist';

    assert.throws(() => resolveDeployPath(), (error) => {
      assert.match(error.message, /PATH looks like it was set to a directory to deploy/);
      assert.match(error.message, /Rename the variable to DEPLOY_PATH/);
      return true;
    });
  });

  test('leaves a genuine search path alone', () => {
    process.env.DEPLOY_PATH = '';
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';

    assert.throws(() => resolveDeployPath(), (error) => {
      assert.match(error.message, /DEPLOY_PATH is empty/);
      assert.ok(!/Rename the variable/.test(error.message));
      return true;
    });
  });
});

describe('the token variable', () => {
  test('is returned trimmed when well formed', () => {
    process.env.BEHINDGATE_TOKEN = '  aaa.bbb.ccc  ';
    assert.equal(resolveToken(), 'aaa.bbb.ccc');
  });

  test('points at repository variables when empty', () => {
    process.env.BEHINDGATE_TOKEN = '';
    assert.throws(() => resolveToken(), /BEHINDGATE_TOKEN is empty/);
  });

  test('reports a malformed token without echoing it', () => {
    process.env.BEHINDGATE_TOKEN = 'nope';
    assert.throws(() => resolveToken(), (error) => {
      assert.match(error.message, /not a well-formed JWT/);
      assert.ok(!error.message.includes('nope'), 'the value must never appear in the message');
      return true;
    });
  });

  test('agrees with the Action about what a well-formed token is', () => {
    // Both call classifyToken. This is the assertion that the sharing is real:
    // a token one wrapper accepts and the other rejects is a bug in one of them.
    const { classifyToken } = require('../../src/core/validate');

    for (const value of ['a.b.c', 'aaa.bbb.', 'x.y', 'a.b.c.d', '', 'a b.c.d']) {
      process.env.BEHINDGATE_TOKEN = value;
      const shared = classifyToken(value).code;

      if (shared === 'ok') {
        assert.equal(resolveToken(), value.trim());
      } else {
        assert.throws(() => resolveToken(), PipeError, `expected ${JSON.stringify(value)} to be rejected`);
      }
    }
  });
});
