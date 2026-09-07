'use strict';

/**
 * Integration tests for the per-pull-request preview flow, against the REAL
 * bg-deploy binary and with no real credentials.
 *
 * These cover what unit tests over `src/core/inputs.js` cannot: that the flags
 * the Action builds are the flags the CLI accepts, and that they reach the
 * deploy API as the calls a preview actually needs -- an app created on the way
 * up, and deleted on the way down.
 *
 * The credential here is the job itself rather than a deploy token: a local
 * stand-in for the Actions token service mints an OIDC token, and the capture
 * server exchanges it. That is the only mode in which --create-app and
 * --delete-app work, and it needs no secret, so these run on forks.
 *
 * They skip on a CLI older than 2026.9.1, which has no preview flags at all.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const { startCaptureServer, startActionsOidcProvider, fakeJwt } = require('../helpers/capture-server');
const { acquireRealCli, previewSupport, makeSiteFixture } = require('../helpers/cli');
const { resolveInputs } = require('../../src/core/inputs');
const { EXIT_CONFIG } = require('../../src/core/errors');

const SITE_URL = 'https://docs.example.com/preview/pr-42';

let cli = null;
let skipReason = null;
let fixture = null;

before(async () => {
  const result = await acquireRealCli();
  if (result.skip) {
    skipReason = result.skip;
    return;
  }
  skipReason = previewSupport(result.binary);
  if (skipReason) return;

  cli = result.binary;
  fixture = makeSiteFixture('site');
}, { timeout: 120000 });

after(() => {
  if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
});

/**
 * Run the CLI exactly as the Action would: the argv comes from resolveInputs,
 * so what these tests exercise is the Action's own invocation rather than a
 * hand-written command that could drift from it.
 */
function runAction(inputs, env = {}) {
  const { args } = resolveInputs(inputs);

  // The Action removes BEHINDGATE_TOKEN when no token input is set, so an
  // inherited one cannot silently change the credential mode.
  const childEnv = { ...process.env, ...env };
  delete childEnv.BEHINDGATE_TOKEN;
  if (inputs.token) childEnv.BEHINDGATE_TOKEN = inputs.token;

  return new Promise((resolve) => {
    execFile(cli, args, { env: childEnv, timeout: 60000 }, (error, stdout, stderr) => {
      resolve({
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout,
        stderr,
        args,
        output: `${stdout}${stderr}`,
      });
    });
  });
}

describe('per-pull-request previews (CLI 2026.9.1)', () => {
  test('trust names the CI trust the OIDC token is exchanged against', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const oidcToken = fakeJwt({ iss: 'https://token.actions.githubusercontent.com' });
    const oidc = await startActionsOidcProvider({ token: oidcToken });
    const server = await startCaptureServer({
      releaseId: 'rel_preview_trust',
      apps: [{ appId: 'app_1', pathPrefix: '/preview/pr-42' }],
    });
    try {
      const { code, output } = await runAction(
        {
          path: fixture.site,
          url: server.url,
          siteUrl: SITE_URL,
          trust: 'trust_01J8ZQ4M2N',
        },
        oidc.env()
      );

      assert.equal(code, 0, `CLI failed:\n${output}`);
      assert.equal(server.exchanges.length, 1);
      assert.equal(server.exchanges[0].trust_id, 'trust_01J8ZQ4M2N');
      // The token the runner minted is the one exchanged, so this covers the
      // credential path itself rather than only the trust that selects it.
      assert.equal(oidc.requests.length, 1);
      assert.equal(server.exchanges[0].subject_token, oidcToken);
    } finally {
      await server.close();
      await oidc.close();
    }
  });

  test('create-app creates the app named by site-url, then deploys into it', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const oidc = await startActionsOidcProvider();
    const server = await startCaptureServer({ releaseId: 'rel_preview_1', apps: [] });
    try {
      const { code, output } = await runAction(
        {
          path: fixture.site,
          url: server.url,
          siteUrl: SITE_URL,
          createApp: 'true',
        },
        oidc.env()
      );

      assert.equal(code, 0, `CLI failed:\n${output}`);

      // The runner's OIDC token was exchanged for a deploy token, scoped to the
      // host half of site-url. No secret was involved anywhere.
      assert.equal(server.exchanges.length, 1);
      assert.equal(server.exchanges[0].site_host, 'docs.example.com');
      assert.equal(
        server.exchanges[0].subject_token_type,
        'urn:ietf:params:oauth:token-type:id_token'
      );

      // The path half of site-url named the app, and it was created because it
      // did not exist yet.
      assert.deepEqual(server.created, [
        { name: '/preview/pr-42', pathPrefix: '/preview/pr-42' },
      ]);

      assert.equal(server.uploads.length, 1, 'the build should still be deployed');
    } finally {
      await server.close();
      await oidc.close();
    }
  });

  test('without create-app a missing app is an error, not a silent creation', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // A mistyped path must not quietly become a new app nobody looks at.
    const oidc = await startActionsOidcProvider();
    const server = await startCaptureServer({ apps: [] });
    try {
      const { code, output } = await runAction(
        { path: fixture.site, url: server.url, siteUrl: SITE_URL },
        oidc.env()
      );

      assert.equal(code, EXIT_CONFIG);
      assert.match(output, /--create-app/);
      assert.equal(server.created.length, 0);
      assert.equal(server.uploads.length, 0);
    } finally {
      await server.close();
      await oidc.close();
    }
  });

  test('delete-app tears the app down and uploads nothing', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const oidc = await startActionsOidcProvider();
    const server = await startCaptureServer({
      apps: [{ appId: 'app_pr42', name: 'pr-42', pathPrefix: '/preview/pr-42' }],
    });
    try {
      const { code, stdout } = await runAction(
        { url: server.url, siteUrl: SITE_URL, deleteApp: 'true' },
        oidc.env()
      );

      assert.equal(code, 0);
      assert.deepEqual(server.deleted, ['app_pr42']);
      assert.equal(server.uploads.length, 0, 'a teardown deploys nothing');
      assert.equal(JSON.parse(stdout).deleted, true);
    } finally {
      await server.close();
      await oidc.close();
    }
  });

  test('deleting a path with no app succeeds, so a teardown job can be re-run', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const oidc = await startActionsOidcProvider();
    const server = await startCaptureServer({ apps: [] });
    try {
      const { code, stdout } = await runAction(
        { url: server.url, siteUrl: SITE_URL, deleteApp: 'true' },
        oidc.env()
      );

      assert.equal(code, 0);
      assert.equal(server.deleted.length, 0);
      assert.equal(JSON.parse(stdout).deleted, false, 'nothing was there to delete');
    } finally {
      await server.close();
      await oidc.close();
    }
  });

  test('a deploy token cannot create or delete an app', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The Action refuses this combination before running anything; the CLI
    // refuses it too. This pins the second half, so the Action's message stays
    // an early, clearer version of a real rule rather than an invented one.
    const server = await startCaptureServer();
    try {
      for (const flag of ['--create-app', '--delete-app']) {
        const { code, output } = await new Promise((resolve) => {
          execFile(
            cli,
            ['-y', '--json', '--url', server.url, flag, fixture.site],
            { env: { ...process.env, BEHINDGATE_TOKEN: fakeJwt({ url: server.url }) }, timeout: 60000 },
            (error, stdout, stderr) =>
              resolve({
                code: error && typeof error.code === 'number' ? error.code : 0,
                output: `${stdout}${stderr}`,
              })
          );
        });

        assert.equal(code, EXIT_CONFIG, flag);
        assert.match(output, /CI trust/i);
      }
      assert.equal(server.uploads.length, 0);
    } finally {
      await server.close();
    }
  });

  test('a deploy token and site-url together are refused by the CLI too', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The Action fails this combination on its inputs, before the CLI is even
    // downloaded. The rule it enforces is the CLI's own.
    const server = await startCaptureServer();
    try {
      const { code, output } = await new Promise((resolve) => {
        execFile(
          cli,
          ['-y', '--json', '--url', server.url, '--site-url', SITE_URL, fixture.site],
          { env: { ...process.env, BEHINDGATE_TOKEN: fakeJwt({ url: server.url }) }, timeout: 60000 },
          (error, stdout, stderr) =>
            resolve({
              code: error && typeof error.code === 'number' ? error.code : 0,
              output: `${stdout}${stderr}`,
            })
        );
      });

      assert.equal(code, EXIT_CONFIG);
      assert.match(output, /BEHINDGATE_TOKEN already names/i);
      assert.equal(server.uploads.length, 0);
    } finally {
      await server.close();
    }
  });

  test('site-url and the endpoint stay separate values', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // They are easy to conflate and mean different things: one is where the
    // release is served from, the other is the API it is uploaded to. If the
    // CLI ever deployed to site-url, the capture server would see nothing.
    const oidc = await startActionsOidcProvider();
    const server = await startCaptureServer({
      apps: [{ appId: 'app_pr42', pathPrefix: '/preview/pr-42' }],
      liveUrl: `${SITE_URL}/`,
    });
    try {
      const { code, stdout } = await runAction(
        { path: fixture.site, url: server.url, siteUrl: SITE_URL },
        oidc.env()
      );

      assert.equal(code, 0);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.endpoint, server.url.replace(/\/$/, ''), 'endpoint is the API');
      assert.equal(parsed.url, `${SITE_URL}/`, 'url is where the site is served');
      assert.notEqual(parsed.endpoint, parsed.url);
    } finally {
      await server.close();
      await oidc.close();
    }
  });
});
