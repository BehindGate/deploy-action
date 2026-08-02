'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  stripAnsi,
  parseReleaseId,
  parseEndpoint,
  parseLiveUrl,
  isSuccessOutput,
  parseDeployOutput,
} = require('../../src/core/parse');

/** Verbatim output from bg-deploy 2026.07.1 on a successful run. */
const SUCCESS_OUTPUT = [
  'Deploying to https://app.example.behindgate.net/api/deploy',
  '  from public',
  'Requesting a release…',
  'Uploading 4210 bytes…',
  'Waiting for extraction…',
  'Publishing…',
  '✓ Deployed. Release rel_01J8ZQ4M2N is live.',
  '',
].join('\n');

const FAILURE_OUTPUT = 'error: not a JWT (expected header.payload.signature)\n';

describe('parseReleaseId', () => {
  test('reads the id from the success line', () => {
    assert.equal(parseReleaseId(SUCCESS_OUTPUT), 'rel_01J8ZQ4M2N');
  });

  test('does not swallow the trailing period', () => {
    assert.equal(parseReleaseId('✓ Deployed. Release abc123 is live.'), 'abc123');
  });

  test('returns null when the CLI failed', () => {
    assert.equal(parseReleaseId(FAILURE_OUTPUT), null);
  });

  test('returns null for empty or nullish output', () => {
    assert.equal(parseReleaseId(''), null);
    assert.equal(parseReleaseId(undefined), null);
    assert.equal(parseReleaseId(null), null);
  });

  test('survives ANSI colour codes', () => {
    const coloured = '[32m✓ Deployed.[0m Release [1mrel_xyz[0m is live.';
    assert.equal(parseReleaseId(coloured), 'rel_xyz');
  });
});

describe('parseEndpoint', () => {
  test('reads the endpoint the CLI actually used', () => {
    assert.equal(parseEndpoint(SUCCESS_OUTPUT), 'https://app.example.behindgate.net/api/deploy');
  });

  test('reads a pinned local endpoint', () => {
    assert.equal(parseEndpoint('Deploying to http://127.0.0.1:8099\n  from site'), 'http://127.0.0.1:8099');
  });

  test('returns null when absent', () => {
    assert.equal(parseEndpoint(FAILURE_OUTPUT), null);
  });
});

describe('parseLiveUrl', () => {
  // bg-deploy 2026.07.1 does not print the deployed address at all. Asserting
  // null here is the point: inventing a URL from the endpoint would put a link
  // in the job summary that does not resolve.
  test('returns null for current CLI output, which omits the URL', () => {
    assert.equal(parseLiveUrl(SUCCESS_OUTPUT), null);
  });

  test('does not mistake the deploy endpoint for the deployed site', () => {
    assert.equal(parseLiveUrl('Deploying to https://app.behindgate.net/api/deploy'), null);
  });

  // Forward compatibility: these light up automatically if upstream adds it.
  test('reads a URL once the CLI prints one', () => {
    assert.equal(
      parseLiveUrl('✓ Deployed. Release abc is live at https://demo.behindgate.net/app/.'),
      'https://demo.behindgate.net/app/'
    );
    assert.equal(
      parseLiveUrl('Deployed at https://demo.behindgate.net/app/'),
      'https://demo.behindgate.net/app/'
    );
    assert.equal(
      parseLiveUrl('URL: https://demo.behindgate.net/app/'),
      'https://demo.behindgate.net/app/'
    );
  });
});

describe('isSuccessOutput', () => {
  test('true for the success line', () => {
    assert.equal(isSuccessOutput(SUCCESS_OUTPUT), true);
  });

  test('false for an error', () => {
    assert.equal(isSuccessOutput(FAILURE_OUTPUT), false);
  });

  test('false for partial progress output', () => {
    assert.equal(isSuccessOutput('Requesting a release…\nUploading 12 bytes…'), false);
  });
});

describe('parseDeployOutput', () => {
  test('returns every field in one pass', () => {
    assert.deepEqual(parseDeployOutput(SUCCESS_OUTPUT), {
      releaseId: 'rel_01J8ZQ4M2N',
      endpoint: 'https://app.example.behindgate.net/api/deploy',
      url: null,
      succeeded: true,
    });
  });

  test('reports nothing usable for a failed run', () => {
    assert.deepEqual(parseDeployOutput(FAILURE_OUTPUT), {
      releaseId: null,
      endpoint: null,
      url: null,
      succeeded: false,
    });
  });
});

describe('stripAnsi', () => {
  test('removes SGR sequences and leaves text intact', () => {
    assert.equal(stripAnsi('[1mbold[0m text'), 'bold text');
  });

  test('coerces nullish input to an empty string', () => {
    assert.equal(stripAnsi(undefined), '');
  });
});
