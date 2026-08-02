'use strict';

/**
 * Integration tests against the REAL bg-deploy binary, with no real credentials.
 *
 * The CLI is pointed at a local capture server with `--url` and a syntactically
 * valid but fake JWT. That needs no secret, so these run on forks and on every
 * pull request.
 *
 * The archive-layout assertion is the important one. bg-deploy zips a folder's
 * CONTENTS, not the folder, so `index.html` lands at the archive root. If that
 * ever regresses to nesting everything under the source folder name, the deploy
 * still succeeds and the job still goes green -- and the published site is
 * broken. Nothing else in this repository would catch it.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { startCaptureServer, fakeJwt } = require('../helpers/capture-server');
const { acquireRealCli, makeSiteFixture } = require('../helpers/cli');
const { listZipEntries } = require('../helpers/zip');
const { parseDeployOutput } = require('../../src/core/parse');
const { EXIT_RUNTIME, EXIT_USAGE } = require('../../src/core/errors');

let cli = null;
let skipReason = null;
let fixture = null;

before(async () => {
  const result = await acquireRealCli();
  if (result.skip) {
    skipReason = result.skip;
    return;
  }
  cli = result.binary;
  fixture = makeSiteFixture('site');
}, { timeout: 120000 });

after(() => {
  if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true });
});

/** Run bg-deploy, capturing output and exit code without throwing. */
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      cli,
      args,
      { env: { ...process.env, ...env }, timeout: 60000 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : 0,
          output: `${stdout}${stderr}`,
        });
      }
    );
  });
}

describe('bg-deploy against a local capture server', () => {
  test('uploads a zip with index.html at the ROOT, not nested under the folder name', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const server = await startCaptureServer();
    try {
      const { code, output } = await runCli(['-y', '--url', server.url, fixture.site], {
        BEHINDGATE_TOKEN: fakeJwt(),
      });

      assert.equal(code, 0, `CLI failed:\n${output}`);
      assert.equal(server.uploads.length, 1, 'expected exactly one upload');

      const entries = listZipEntries(server.uploads[0]);

      // The assertion that protects against a green deploy of a broken site.
      assert.ok(entries.includes('index.html'), `index.html not at zip root; got ${JSON.stringify(entries)}`);
      assert.ok(entries.includes('assets/app.css'), `nested asset lost; got ${JSON.stringify(entries)}`);

      for (const entry of entries) {
        assert.ok(!entry.startsWith('site/'), `entry "${entry}" is nested under the source folder name`);
        assert.ok(!entry.startsWith('/'), `entry "${entry}" has an absolute path`);
        assert.ok(!entry.includes('..'), `entry "${entry}" escapes the archive root`);
      }
    } finally {
      await server.close();
    }
  });

  test('follows the documented protocol: create, upload, poll, publish', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const server = await startCaptureServer({ releaseId: 'rel_proto_1', pollsBeforeReady: 2 });
    try {
      const { code } = await runCli(['-y', '--url', server.url, fixture.site], {
        BEHINDGATE_TOKEN: fakeJwt(),
      });
      assert.equal(code, 0);

      const create = server.requests[0];
      assert.equal(create.method, 'POST');
      assert.equal(create.body.length, 0, 'release creation posts an empty body');

      const upload = server.requests.find((r) => r.method === 'PUT');
      assert.ok(upload, 'expected a PUT upload');
      assert.equal(upload.headers['content-type'], 'application/zip');

      const polls = server.requests.filter((r) => r.method === 'GET');
      assert.ok(polls.length >= 2, 'expected the CLI to poll until extraction finished');
      assert.ok(polls.every((r) => r.path.includes('rel_proto_1')));

      const publish = server.requests.find((r) => r.path.endsWith('/publish'));
      assert.ok(publish, 'expected a publish call');
      assert.deepEqual(JSON.parse(publish.bodyText), { releaseId: 'rel_proto_1' });
    } finally {
      await server.close();
    }
  });

  test('authenticates with a bearer token and never puts it in argv', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const token = fakeJwt();
    const server = await startCaptureServer();
    try {
      const args = ['-y', '--url', server.url, fixture.site];
      const { code, output } = await runCli(args, { BEHINDGATE_TOKEN: token });
      assert.equal(code, 0);

      const create = server.requests[0];
      assert.equal(create.headers.authorization, `Bearer ${token}`);

      // The token reaches the API, but never the command line or the console.
      assert.ok(!args.join(' ').includes(token), 'token leaked into argv');
      assert.ok(!output.includes(token), 'token leaked into CLI output');
    } finally {
      await server.close();
    }
  });

  test('release id is parseable from real CLI output', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const server = await startCaptureServer({ releaseId: 'rel_parse_me_9' });
    try {
      const { output } = await runCli(['-y', '--url', server.url, fixture.site], {
        BEHINDGATE_TOKEN: fakeJwt(),
      });

      const parsed = parseDeployOutput(output);
      assert.equal(parsed.succeeded, true);
      assert.equal(parsed.releaseId, 'rel_parse_me_9');
      assert.equal(parsed.endpoint, server.url.replace(/\/$/, ''));
      // Documents the gap: the CLI never prints the deployed address.
      assert.equal(parsed.url, null);
    } finally {
      await server.close();
    }
  });

  test('an existing .zip is uploaded as-is', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // Build a zip via the CLI itself, then feed it back in.
    const first = await startCaptureServer();
    let zipBuffer;
    try {
      await runCli(['-y', '--url', first.url, fixture.site], { BEHINDGATE_TOKEN: fakeJwt() });
      zipBuffer = first.uploads[0];
    } finally {
      await first.close();
    }

    const zipPath = path.join(fixture.root, 'prebuilt.zip');
    fs.writeFileSync(zipPath, zipBuffer);

    const server = await startCaptureServer();
    try {
      const { code } = await runCli(['-y', '--url', server.url, zipPath], {
        BEHINDGATE_TOKEN: fakeJwt(),
      });
      assert.equal(code, 0);
      assert.deepEqual(
        listZipEntries(server.uploads[0]).sort(),
        listZipEntries(zipBuffer).sort(),
        'a prebuilt .zip should be uploaded unchanged'
      );
    } finally {
      await server.close();
    }
  });

  // Why this test exists: it is the concrete demonstration behind the `url`
  // input. With no --url, the CLI sends the build wherever the TOKEN says --
  // here, a server the workflow author never named -- and still exits 0.
  test('without --url the endpoint comes from the token, and the run still succeeds', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const server = await startCaptureServer();
    try {
      const { code, output } = await runCli(['-y', fixture.site], {
        BEHINDGATE_TOKEN: fakeJwt({ url: server.url }),
      });

      assert.equal(code, 0, 'the redirected deploy reports success');
      assert.equal(server.uploads.length, 1, 'the build went to the token-nominated host');
      assert.match(output, /Deployed\. Release .+ is live/);
    } finally {
      await server.close();
    }
  });
});

describe('bg-deploy exit codes (pins the mapping in src/core/errors.js to reality)', () => {
  test('a missing token is a USAGE error (exit 2), not a runtime failure', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const { code, output } = await runCli(['-y', fixture.site], { BEHINDGATE_TOKEN: '' });
    assert.equal(code, EXIT_USAGE);
    assert.match(output, /BEHINDGATE_TOKEN is not set/);
  });

  test('a malformed token is a RUNTIME failure (exit 1), despite also being a credential problem', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const { code, output } = await runCli(['-y', fixture.site], { BEHINDGATE_TOKEN: 'not-a-jwt' });
    assert.equal(code, EXIT_RUNTIME);
    assert.match(output, /not a JWT/);
  });

  test('a missing path is a usage error (exit 2)', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const { code } = await runCli(['-y'], { BEHINDGATE_TOKEN: fakeJwt() });
    assert.equal(code, EXIT_USAGE);
  });

  test('an unknown flag is a usage error (exit 2)', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const { code } = await runCli(['--nope', fixture.site], { BEHINDGATE_TOKEN: fakeJwt() });
    assert.equal(code, EXIT_USAGE);
  });
});
