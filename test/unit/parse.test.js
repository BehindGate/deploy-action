'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  stripAnsi,
  extractJson,
  parseDeployJson,
  parseErrorMessage,
} = require('../../src/core/parse');

/** Verbatim stdout from `bg-deploy --json` 2026.8.3 on a successful run. */
const SUCCESS_STDOUT =
  '{"releaseId":"rel_01J8ZQ4M2N","url":"https://demo.behindgate.com/my-app/",' +
  '"endpoint":"https://app.behindgate.com/api/deploy","status":"published",' +
  '"version":"2026.8.3"}\n';

/** Human progress goes to stderr, and must never be parsed as the result. */
const SUCCESS_STDERR = [
  'Deploying to https://app.behindgate.com/api/deploy',
  '  from public',
  'Requesting a release…',
  'Uploading 4210 bytes…',
  'Waiting for extraction…',
  'Publishing…',
  '',
].join('\n');

describe('parseDeployJson', () => {
  test('reads every field from a successful run', () => {
    assert.deepEqual(parseDeployJson(SUCCESS_STDOUT), {
      releaseId: 'rel_01J8ZQ4M2N',
      url: 'https://demo.behindgate.com/my-app/',
      endpoint: 'https://app.behindgate.com/api/deploy',
      status: 'published',
      version: '2026.8.3',
    });
  });

  test('the deployed URL is now available, so the url output can populate', () => {
    // Against pre-2026.8 CLIs this was unobtainable: the success line carried
    // only the release id and there was no structured output at all.
    assert.equal(parseDeployJson(SUCCESS_STDOUT).url, 'https://demo.behindgate.com/my-app/');
  });

  test('tolerates surrounding whitespace', () => {
    assert.equal(parseDeployJson(`\n\n${SUCCESS_STDOUT}\n`).releaseId, 'rel_01J8ZQ4M2N');
  });

  test('finds the result even if a stray line precedes it', () => {
    const noisy = `warning: something\n${SUCCESS_STDOUT}`;
    assert.equal(parseDeployJson(noisy).releaseId, 'rel_01J8ZQ4M2N');
  });

  test('missing fields come back as null rather than undefined', () => {
    const parsed = parseDeployJson('{"releaseId":"abc"}');
    assert.equal(parsed.releaseId, 'abc');
    assert.equal(parsed.url, null);
    assert.equal(parsed.endpoint, null);
  });

  test('empty strings are treated as absent', () => {
    assert.equal(parseDeployJson('{"releaseId":"abc","url":""}').url, null);
  });

  test('returns null for unparseable output rather than a hollow object', () => {
    // Callers warn on null; a hollow object would publish empty outputs as if
    // they were real results.
    assert.equal(parseDeployJson(''), null);
    assert.equal(parseDeployJson('not json'), null);
    assert.equal(parseDeployJson(undefined), null);
  });

  test('rejects a JSON array, which is not a result object', () => {
    assert.equal(parseDeployJson('[1,2,3]'), null);
  });

  test('never parses the human progress stream as a result', () => {
    assert.equal(parseDeployJson(SUCCESS_STDERR), null);
  });
});

describe('parseErrorMessage', () => {
  test('reads a structured error from stdout', () => {
    const stdout = '{"error":{"code":"not_a_jwt","message":"not a JWT"}}';
    assert.equal(parseErrorMessage({ stdout }), 'not a JWT (not_a_jwt)');
  });

  test('omits the code when absent', () => {
    assert.equal(parseErrorMessage({ stdout: '{"error":{"message":"boom"}}' }), 'boom');
  });

  test('falls back to a plain error: line on stderr', () => {
    // A failure early in startup may never reach structured output.
    const stderr = 'error: BEHINDGATE_TOKEN is not set\n';
    assert.equal(parseErrorMessage({ stderr }), 'BEHINDGATE_TOKEN is not set');
  });

  test('reads the endpoint-mismatch refusal', () => {
    const stderr =
      'error: token claims endpoint http://a/ but --url pins http://b/; refusing to deploy\n';
    assert.match(parseErrorMessage({ stderr }), /refusing to deploy/);
  });

  test('returns null when there is no error to report', () => {
    assert.equal(parseErrorMessage({ stdout: SUCCESS_STDOUT, stderr: '' }), null);
    assert.equal(parseErrorMessage(), null);
  });
});

describe('extractJson', () => {
  test('returns the parsed object', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  });

  test('survives ANSI colour codes', () => {
    assert.deepEqual(extractJson('[32m{"a":1}[0m'), { a: 1 });
  });
});

describe('stripAnsi', () => {
  test('removes SGR sequences and leaves text intact', () => {
    assert.equal(stripAnsi('[1mbold[0m text'), 'bold text');
  });

  test('coerces nullish input to an empty string', () => {
    assert.equal(stripAnsi(undefined), '');
  });
});
