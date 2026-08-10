'use strict';

/**
 * Integration tests for the GitLab component's shell, with no real credentials.
 *
 * `src/gitlab/deploy.sh` is run exactly as it ships -- it is spliced verbatim
 * into templates/deploy.yml, and a unit test enforces that. Two local servers
 * stand in for the outside world: one serves the real bg-deploy archive so the
 * download-and-verify path runs for real, the other captures the deploy so the
 * CLI has somewhere to publish to.
 *
 * The checksum test is the one that earns its keep. Everything else in this
 * repository asserts about the verification code; this runs it, against bytes
 * that really do not match, and confirms the binary is never executed.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { startCaptureServer, fakeJwt } = require('../helpers/capture-server');
const { startDownloadServer } = require('../helpers/download-server');
const { acquireRealCli, makeSiteFixture } = require('../helpers/cli');

const SCRIPT = path.join(__dirname, '..', '..', 'src', 'gitlab', 'deploy.sh');

let skipReason = null;
let downloads = null;
let cliVersion = null;
const workspaces = [];

before(async () => {
  if (process.platform === 'win32') {
    skipReason = 'the component is POSIX shell; not run on Windows';
    return;
  }

  const cli = await acquireRealCli();
  if (cli.skip) {
    skipReason = cli.skip;
    return;
  }

  cliVersion = cli.version;

  // Served under the same layout the real host uses, so the URL the script
  // builds is exercised rather than stubbed.
  const files = new Map([
    [`${cli.version}/${cli.artifact.archive}`, fs.readFileSync(cli.archivePath)],
  ]);
  downloads = await startDownloadServer(files);
}, { timeout: 120000 });

after(async () => {
  if (downloads) await downloads.close();
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway job workspace containing a site to deploy. */
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-gitlab-'));
  workspaces.push(dir);

  const { root, site } = makeSiteFixture('public');
  fs.cpSync(site, path.join(dir, 'public'), { recursive: true });
  fs.rmSync(root, { recursive: true, force: true });

  return dir;
}

/** Run the component's script the way the job does: `sh`, in the workspace. */
function runComponent(cwd, env = {}) {
  return new Promise((resolve) => {
    execFile(
      'sh',
      [SCRIPT],
      {
        cwd,
        env: {
          ...process.env,
          BEHINDGATE_TOKEN: fakeJwt(),
          BG_PATH: 'public',
          BG_URL: '',
          BG_CLI_VERSION: '',
          BG_DOWNLOAD_BASE_URL: downloads ? downloads.url : '',
          ...env,
        },
        timeout: 90000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === 'number' ? error.code : 0,
          stdout,
          stderr,
          output: `${stdout}${stderr}`,
        });
      }
    );
  });
}

function readDotenv(cwd) {
  const file = path.join(cwd, 'behindgate.env');
  if (!fs.existsSync(file)) return null;

  return Object.fromEntries(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      })
  );
}

describe('the GitLab component deploys', () => {
  test('downloads the CLI, verifies it, deploys, and publishes a dotenv report', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cwd = makeWorkspace();
    const capture = await startCaptureServer();

    try {
      const result = await runComponent(cwd, { BG_URL: capture.url });

      assert.equal(result.code, 0, `component failed:\n${result.output}`);
      assert.match(result.output, /Checksum verified/);
      assert.equal(capture.uploads.length, 1, 'expected exactly one upload');

      const env = readDotenv(cwd);
      assert.ok(env, 'behindgate.env was not written');
      assert.equal(env.BEHINDGATE_RELEASE_ID, 'rel_test_0001');
      assert.equal(env.BEHINDGATE_URL, 'https://demo.test.behindgate.net/my-app/');
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('reuses the cached archive on a second run without re-downloading', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cwd = makeWorkspace();
    const capture = await startCaptureServer();

    try {
      await runComponent(cwd, { BG_URL: capture.url });
      const before = downloads.requests.length;

      const second = await runComponent(cwd, { BG_URL: capture.url });

      assert.equal(second.code, 0, `second run failed:\n${second.output}`);
      assert.match(second.output, /Using the cached bg-deploy/);
      assert.equal(
        downloads.requests.length,
        before,
        'the cached archive still matched the pin, so nothing should have been fetched'
      );
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('leaves no extracted binary behind in the workspace', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cwd = makeWorkspace();
    const capture = await startCaptureServer();

    try {
      await runComponent(cwd, { BG_URL: capture.url });

      assert.ok(!fs.existsSync(path.join(cwd, '.bg-deploy-run')), 'the run directory was kept');
      assert.ok(fs.existsSync(path.join(cwd, '.bg-deploy-cache')), 'the archive cache was dropped');
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });
});

describe('the GitLab component refuses to run an unverified binary', () => {
  test('a download that does not match the pin fails before anything is extracted', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cwd = makeWorkspace();
    const capture = await startCaptureServer();
    downloads.corrupt = true;

    try {
      const result = await runComponent(cwd, { BG_URL: capture.url });

      assert.notEqual(result.code, 0, 'a tampered download must fail the job');
      assert.match(result.output, /Checksum verification failed/);
      assert.equal(capture.requests.length, 0, 'the CLI must never have run');
      assert.ok(!fs.existsSync(path.join(cwd, 'behindgate.env')), 'no outputs may be published');

      // The bad bytes must not survive as a cache entry, or the next run would
      // fail identically with no way to recover short of clearing the cache.
      const cached = path.join(cwd, '.bg-deploy-cache', cliVersion);
      const leftovers = fs.existsSync(cached) ? fs.readdirSync(cached) : [];
      assert.deepEqual(leftovers, [], 'the rejected archive was left in the cache');
    } finally {
      downloads.corrupt = false;
      await capture.close();
    }
  }, { timeout: 120000 });

  test('a version with no pinned checksum is refused rather than downloaded', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cwd = makeWorkspace();
    const before = downloads.requests.length;

    const result = await runComponent(cwd, { BG_CLI_VERSION: '2026.1.1' });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /No pinned checksum for bg-deploy 2026\.1\.1/);
    assert.equal(downloads.requests.length, before, 'nothing may be fetched for an unpinned version');
  }, { timeout: 60000 });
});

describe('the GitLab component fails early on bad configuration', () => {
  test('an empty token names the CI/CD variable rather than failing inside the CLI', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const result = await runComponent(makeWorkspace(), { BEHINDGATE_TOKEN: '' });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /BEHINDGATE_TOKEN is empty/);
    assert.match(result.stderr, /Protected/);
  });

  test('a malformed token is reported as malformed, and never echoed', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const result = await runComponent(makeWorkspace(), { BEHINDGATE_TOKEN: 'not-a-jwt' });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not a well-formed JWT/);
    assert.ok(!result.output.includes('not-a-jwt'), 'the token value must never be echoed');
  });

  test('a path that does not exist is reported before the CLI is downloaded', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const before = downloads.requests.length;
    const result = await runComponent(makeWorkspace(), { BG_PATH: 'no-such-dir' });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /does not exist in the job workspace/);
    assert.equal(downloads.requests.length, before, 'the CLI must not be fetched for a bad path');
  });

  test('an unpinned endpoint warns about what the job is trusting', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // No BG_URL, so the endpoint comes from the token's own claim. The deploy
    // itself then fails against a claim pointing nowhere -- the warning is what
    // is under test, and it has to appear before that failure.
    const result = await runComponent(makeWorkspace(), {
      BEHINDGATE_TOKEN: fakeJwt({ url: 'http://127.0.0.1:1/deploy' }),
    });

    assert.match(result.stderr, /no `url` input set/);
    assert.match(result.stderr, /credential and a routing instruction/);
  }, { timeout: 120000 });
});
