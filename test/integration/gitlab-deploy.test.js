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
const { listZipEntries } = require('../helpers/zip');

const SCRIPT = path.join(__dirname, '..', '..', 'src', 'gitlab', 'deploy.sh');

let skipReason = null;
let downloads = null;
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

  // A throw in here is reported as cancelled subtests rather than as a failure,
  // which hides the reason completely. Turn it into a skip that names it.
  try {
    // Served under the same layout the real host uses, so the URL the script
    // builds is exercised rather than stubbed.
    const files = new Map([
      [`${cli.version}/${cli.artifact.archive}`, fs.readFileSync(cli.archivePath)],
    ]);
    downloads = await startDownloadServer(files);
  } catch (error) {
    skipReason = `could not stage the CLI archive for the local download host: ${error.message}`;
  }
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

/**
 * Every file under a directory, with its size and mode.
 *
 * The component promises never to write to the project directory, and a promise
 * about the filesystem is only worth what a filesystem check says it is worth.
 */
function snapshot(dir) {
  const entries = [];

  (function walk(absolute, relative) {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const next = path.join(absolute, entry.name);
      const key = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries.push(`dir  ${key}`);
        walk(next, key);
      } else {
        const stat = fs.statSync(next);
        entries.push(`file ${key} ${stat.size} ${(stat.mode & 0o777).toString(8)}`);
      }
    }
  })(dir, '');

  return entries;
}

describe('the GitLab component deploys', () => {
  test('downloads the CLI, verifies it, and deploys', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cwd = makeWorkspace();
    const capture = await startCaptureServer();

    try {
      const result = await runComponent(cwd, { BG_URL: capture.url });

      assert.equal(result.code, 0, `component failed:\n${result.output}`);
      assert.match(result.output, /Checksum verified/);
      assert.equal(capture.uploads.length, 1, 'expected exactly one upload');

      // Reported to the log, written nowhere.
      assert.match(result.output, /Deployed release rel_test_0001/);
      assert.match(result.output, /https:\/\/demo\.test\.behindgate\.net\/my-app\//);
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('leaves the project directory byte-for-byte untouched', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // `path: .` deploys the project directory, so anything the component leaves
    // behind is published as part of the site. That makes a stray scratch file a
    // defect rather than an untidiness, and this is what catches one.
    const cwd = makeWorkspace();
    const capture = await startCaptureServer();
    const before = snapshot(cwd);

    try {
      const result = await runComponent(cwd, { BG_URL: capture.url });

      assert.equal(result.code, 0, `component failed:\n${result.output}`);
      assert.equal(capture.uploads.length, 1, 'the deploy must still have happened');
      assert.deepEqual(snapshot(cwd), before, 'the component wrote to the project directory');
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('deploying the project directory itself uploads no scratch files', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cwd = makeWorkspace();
    const capture = await startCaptureServer();

    try {
      const result = await runComponent(cwd, { BG_URL: capture.url, BG_PATH: '.' });

      assert.equal(result.code, 0, `component failed:\n${result.output}`);

      const names = listZipEntries(capture.uploads[0]);
      const scratch = names.filter((name) => /bg-deploy|behindgate\.env/.test(name));
      assert.deepEqual(scratch, [], `component scratch files were published: ${scratch}`);
      assert.ok(names.includes('public/index.html'), `expected the site contents, got ${names}`);
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
    const before = snapshot(cwd);
    downloads.corrupt = true;

    try {
      const result = await runComponent(cwd, { BG_URL: capture.url });

      assert.notEqual(result.code, 0, 'a tampered download must fail the job');
      assert.match(result.output, /Checksum verification failed/);
      assert.equal(capture.requests.length, 0, 'the CLI must never have run');

      // A rejected download must not survive anywhere the next job could reach.
      assert.deepEqual(snapshot(cwd), before, 'the rejected archive was left behind');
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

  test('applies the same token shape rule the Action does', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The component is shell running in someone else's pipeline, so it cannot
    // import the Action's check and reimplements it. That is exactly the kind of
    // duplicate that drifts, and a token one wrapper accepts while another
    // rejects is a bug in one of them. The corpus below is the rule stated
    // explicitly: three non-empty base64url segments.
    //
    // The token check runs before the path check, so a token the shell accepts
    // gets as far as complaining about the path.
    const corpus = [
      ['a.b.c', true],
      ['aaa.bbb.', true],
      ['A-Z_a-z.0-9.sig', true],
      ['x.y', false],
      ['a.b.c.d', false],
      ['a b.c.d', false],
      ['a.b.c!', false],
      ['.b.c', false],
      ['a..c', false],
    ];

    for (const [value, accepted] of corpus) {
      const result = await runComponent(makeWorkspace(), {
        BEHINDGATE_TOKEN: value,
        BG_PATH: 'no-such-dir',
      });

      const rejected = /not a well-formed JWT/.test(result.stderr);
      assert.equal(
        rejected,
        !accepted,
        `the shell verdict on ${JSON.stringify(value)} does not match the documented rule`
      );
      assert.ok(!result.output.includes(value), 'the token value must never be echoed');
    }
  }, { timeout: 60000 });

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
