'use strict';

/**
 * Integration tests for the Bitbucket Pipe's entrypoint, with no credentials.
 *
 * The entrypoint is run as a process, exactly as the container's ENTRYPOINT
 * runs it, against two local servers: one serving the real bg-deploy archive so
 * the download-and-verify path runs for real, one capturing the deploy.
 *
 * The image itself is not built here -- there is no Docker daemon in every
 * environment this suite runs in -- so the Dockerfile is covered by a CI job
 * instead. What is covered here is everything the image would execute.
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

const ENTRYPOINT = path.join(__dirname, '..', '..', 'src', 'bitbucket', 'index.js');

let skipReason = null;
let downloads = null;
let bakedDir = null;
const workspaces = [];

before(async () => {
  if (process.platform === 'win32') {
    skipReason = 'the pipe image is Linux; not run on Windows';
    return;
  }

  const cli = await acquireRealCli();
  if (cli.skip) {
    skipReason = cli.skip;
    return;
  }

  try {
    const archive = fs.readFileSync(cli.archivePath);
    downloads = await startDownloadServer(
      new Map([[`${cli.version}/${cli.artifact.archive}`, archive]])
    );

    // Stands in for what the Dockerfile bakes into /opt/bg-deploy, so the
    // no-download path is exercised with the same layout the image uses.
    bakedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-baked-'));
    fs.mkdirSync(path.join(bakedDir, cli.version), { recursive: true });
    fs.writeFileSync(path.join(bakedDir, cli.version, cli.artifact.archive), archive);
  } catch (error) {
    skipReason = `could not stage the CLI archive: ${error.message}`;
  }
}, { timeout: 120000 });

after(async () => {
  if (downloads) await downloads.close();
  if (bakedDir) fs.rmSync(bakedDir, { recursive: true, force: true });
  for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway clone directory containing a site to deploy. */
function makeCloneDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-bitbucket-'));
  workspaces.push(dir);

  const { root, site } = makeSiteFixture('dist');
  fs.cpSync(site, path.join(dir, 'dist'), { recursive: true });
  fs.rmSync(root, { recursive: true, force: true });

  return dir;
}

/**
 * Run the entrypoint the way the container does: as a process, with pipe
 * variables in the environment and BITBUCKET_CLONE_DIR pointing at the
 * checkout. `baked: false` empties the image cache so the download path runs.
 */
function runPipe(cloneDir, variables = {}, { baked = true } = {}) {
  const env = {
    ...process.env,
    BITBUCKET_CLONE_DIR: cloneDir,
    BEHINDGATE_TOKEN: fakeJwt(),
    DEPLOY_PATH: 'dist',
    DEPLOY_URL: '',
    CLI_VERSION: '',
    DOWNLOAD_BASE_URL: downloads ? downloads.url : '',
    BG_PIPE_ARCHIVE_DIR: baked ? bakedDir : path.join(cloneDir, 'no-such-cache'),
    ...variables,
  };

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [ENTRYPOINT],
      { cwd: cloneDir, env, timeout: 90000 },
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
 * The pipe promises never to write to the checkout, and a promise about the
 * filesystem is only worth what a filesystem check says it is worth.
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

describe('the Bitbucket Pipe deploys', () => {
  test('uses the archive baked into the image, without downloading', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cloneDir = makeCloneDir();
    const capture = await startCaptureServer();
    const before = downloads.requests.length;

    try {
      const result = await runPipe(cloneDir, { DEPLOY_URL: capture.url });

      assert.equal(result.code, 0, `pipe failed:\n${result.output}`);
      assert.match(result.output, /baked into this image/);
      assert.match(result.output, /Checksum verified/);
      assert.equal(
        downloads.requests.length,
        before,
        'a baked archive must not be re-downloaded'
      );
      assert.equal(capture.uploads.length, 1, 'expected exactly one upload');

      // Reported to the log, written nowhere.
      assert.match(result.output, /Deployed release rel_test_0001/);
      assert.match(result.output, /https:\/\/demo\.test\.behindgate\.net\/my-app\//);
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('falls back to downloading when the image carries no archive', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cloneDir = makeCloneDir();
    const capture = await startCaptureServer();
    const before = downloads.requests.length;

    try {
      const result = await runPipe(cloneDir, { DEPLOY_URL: capture.url }, { baked: false });

      assert.equal(result.code, 0, `pipe failed:\n${result.output}`);
      assert.match(result.output, /Downloading bg-deploy/);
      assert.ok(downloads.requests.length > before, 'expected a download');
      assert.equal(capture.uploads.length, 1);
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('leaves the checkout byte-for-byte untouched', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The contract is: upload a directory. Nothing about that requires writing
    // to someone's repository, and an earlier draft that dropped a
    // behindgate.env beside their source is what forced this container to run
    // as root. This is the assertion that keeps it honest.
    const cloneDir = makeCloneDir();
    const capture = await startCaptureServer();
    const before = snapshot(cloneDir);

    try {
      const result = await runPipe(cloneDir, { DEPLOY_URL: capture.url });

      assert.equal(result.code, 0, `pipe failed:\n${result.output}`);
      assert.equal(capture.uploads.length, 1, 'the deploy must still have happened');
      assert.deepEqual(snapshot(cloneDir), before, 'the pipe wrote to the checkout');
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('resolves DEPLOY_PATH against the clone dir, not the process cwd', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cloneDir = makeCloneDir();
    const capture = await startCaptureServer();

    try {
      // Started from somewhere else entirely: the image's WORKDIR is /pipe, so
      // a relative path that only worked from the cwd would be a live bug.
      const result = await new Promise((resolve) => {
        execFile(
          process.execPath,
          [ENTRYPOINT],
          {
            cwd: os.tmpdir(),
            env: {
              ...process.env,
              BITBUCKET_CLONE_DIR: cloneDir,
              BEHINDGATE_TOKEN: fakeJwt(),
              DEPLOY_PATH: 'dist',
              DEPLOY_URL: capture.url,
              CLI_VERSION: '',
              DOWNLOAD_BASE_URL: downloads.url,
              BG_PIPE_ARCHIVE_DIR: bakedDir,
            },
            timeout: 90000,
          },
          (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: `${stdout}${stderr}` })
        );
      });

      assert.equal(result.code, 0, `pipe failed:\n${result.output}`);
      assert.equal(capture.uploads.length, 1);
      assert.match(result.output, /Deployed release/);
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });
});

describe('the Bitbucket Pipe refuses to run an unverified binary', () => {
  test('a download that does not match the pin fails before extraction', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const cloneDir = makeCloneDir();
    const capture = await startCaptureServer();
    downloads.corrupt = true;

    try {
      const result = await runPipe(cloneDir, { DEPLOY_URL: capture.url }, { baked: false });

      assert.notEqual(result.code, 0, 'a tampered download must fail the step');
      assert.match(result.output, /Checksum verification failed/);
      assert.equal(capture.requests.length, 0, 'the CLI must never have run');
    } finally {
      downloads.corrupt = false;
      await capture.close();
    }
  }, { timeout: 120000 });

  test('an unpinned CLI version is refused rather than downloaded', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const before = downloads.requests.length;
    const result = await runPipe(makeCloneDir(), { CLI_VERSION: '2026.1.1' });

    assert.notEqual(result.code, 0);
    assert.match(result.output, /No pinned checksums for bg-deploy version "2026\.1\.1"/);
    assert.equal(downloads.requests.length, before);
  }, { timeout: 60000 });
});

describe('the Bitbucket Pipe fails early on bad configuration', () => {
  test('an empty token names the repository variable', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const result = await runPipe(makeCloneDir(), { BEHINDGATE_TOKEN: '' });

    assert.notEqual(result.code, 0);
    assert.match(result.output, /BEHINDGATE_TOKEN is empty/);
    assert.match(result.output, /Secured/);
  });

  test('a malformed token is reported as malformed, and never echoed', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const result = await runPipe(makeCloneDir(), { BEHINDGATE_TOKEN: 'not-a-jwt' });

    assert.notEqual(result.code, 0);
    assert.match(result.output, /not a well-formed JWT/);
    assert.ok(!result.output.includes('not-a-jwt'));
  });

  test('a missing DEPLOY_PATH shows the variable block to copy', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const result = await runPipe(makeCloneDir(), { DEPLOY_PATH: '' });

    assert.notEqual(result.code, 0);
    assert.match(result.output, /DEPLOY_PATH is empty/);
    assert.match(result.output, /DEPLOY_PATH: dist/);
  });

  test('a path that does not exist is reported before the CLI is acquired', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const result = await runPipe(makeCloneDir(), { DEPLOY_PATH: 'no-such-dir' });

    assert.notEqual(result.code, 0);
    assert.match(result.output, /does not exist in/);
    assert.match(result.output, /artifacts:/);
  });

  test('an unpinned endpoint warns about what the step is trusting', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const result = await runPipe(makeCloneDir(), {
      BEHINDGATE_TOKEN: fakeJwt({ url: 'http://127.0.0.1:1/deploy' }),
    });

    assert.match(result.output, /DEPLOY_URL is not set/);
    assert.match(result.output, /credential and a routing instruction/);
  }, { timeout: 120000 });
});
