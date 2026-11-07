#!/usr/bin/env node
'use strict';

/**
 * Checks that the tags a workflow wrote as expressions arrived on the release.
 *
 * The values are resolved by the calling workflow, so this is the one place
 * that proves an expression in `tags:` survives the whole path to the wire.
 */

const fs = require('node:fs');
const assert = require('node:assert/strict');

const requests = JSON.parse(fs.readFileSync(process.env.CAPTURE_REQUESTS, 'utf8'));

const create = requests.find(
  (request) =>
    request.method === 'POST' &&
    !request.path.endsWith('/publish') &&
    !request.path.startsWith('/upload/') &&
    !request.path.endsWith('/oidc/token')
);

assert.ok(create, 'the Action created no release');

assert.deepEqual(JSON.parse(create.bodyText).tags, [
  { name: 'sha', value: process.env.EXPECTED_SHA },
  { name: 'run', value: process.env.EXPECTED_RUN },
  { name: 'nightly' },
]);

console.log('Tags reached the release as written.');
