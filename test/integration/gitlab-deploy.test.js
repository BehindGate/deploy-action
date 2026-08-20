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
const { ENVIRONMENTS, DEFAULT_ENVIRONMENT } = require('../../src/core/environments');
const { oidcCapableVersions } = require('../../script/build-gitlab-template');
const { DEFAULT_TABLE } = require('../../src/core/versions');

const SCRIPT = path.join(__dirname, '..', '..', 'src', 'gitlab', 'deploy.sh');

/** The origin the component defaults to, which is also its default audience. */
const DEFAULT_ORIGIN = new URL(ENVIRONMENTS[DEFAULT_ENVIRONMENT].deployUrl).origin;

/**
 * The CLI the component installs by default: the newest pinned release that can
 * exchange an OIDC token, fetched from wherever its pin was captured.
 *
 * Not `versions.defaultVersion()`, which belongs to the Action. The two differ
 * for as long as the OIDC-capable release is ahead of production, and it is the
 * component's choice these tests have to exercise.
 */
const CLI_VERSION = oidcCapableVersions(DEFAULT_TABLE).at(-1);
const CLI_BASE_URL = DEFAULT_TABLE.versions[CLI_VERSION].capturedFrom;

let skipReason = null;
let downloads = null;
const workspaces = [];

before(async () => {
  if (process.platform === 'win32') {
    skipReason = 'the component is POSIX shell; not run on Windows';
    return;
  }

  const cli = await acquireRealCli({ version: CLI_VERSION, baseUrl: CLI_BASE_URL });
  if (cli.skip) {
    skipReason = cli.skip;
    return;
  }

  // BG_CLI_BINARY hands over a binary directly, bypassing the pinned download
  // these tests exist to exercise -- there is no archive to serve locally.
  if (!cli.archivePath) {
    skipReason = 'BG_CLI_BINARY is set, so there is no pinned archive to serve';
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

/**
 * Run the component's script the way the job does: `sh`, in the workspace.
 *
 * The default credential is the OIDC token, because that is what the component
 * declares an `id_tokens:` block for and what a job gets with nothing
 * configured. Tests of the deploy-token fallback pass BEHINDGATE_TOKEN, which
 * takes precedence in the script exactly as it does in the CLI.
 */
function runComponent(cwd, env = {}) {
  return new Promise((resolve) => {
    execFile(
      'sh',
      [SCRIPT],
      {
        cwd,
        env: {
          ...process.env,
          BEHINDGATE_TOKEN: '',
          BEHINDGATE_OIDC_TOKEN: fakeJwt({ aud: DEFAULT_ORIGIN }),
          BG_APP_ORIGIN: '',
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

  test('unpacks under CI_BUILDS_DIR when the temp filesystem is unusable', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The CLI is executed from wherever it is unpacked, so that directory has to
    // allow execution. /tmp is mounted noexec on plenty of hardened runners.
    // Pointing TMPDIR at nothing proves CI_BUILDS_DIR is genuinely tried first
    // rather than merely listed.
    const builds = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-builds-'));
    workspaces.push(builds);

    const cwd = makeWorkspace();
    const capture = await startCaptureServer();

    try {
      const result = await runComponent(cwd, {
        BG_URL: capture.url,
        CI_BUILDS_DIR: builds,
        TMPDIR: path.join(builds, 'no-such-tmpdir'),
      });

      assert.equal(result.code, 0, `component failed:\n${result.output}`);
      assert.equal(capture.uploads.length, 1);
      assert.deepEqual(fs.readdirSync(builds), [], 'the scratch directory was not cleaned up');
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('says so when nowhere allows execution', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const missing = path.join(os.tmpdir(), 'bg-nowhere-that-exists');
    const result = await runComponent(makeWorkspace(), {
      CI_BUILDS_DIR: missing,
      TMPDIR: missing,
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Found nowhere to unpack the CLI that allows execution/);
    assert.match(result.stderr, /mounted noexec/);
  }, { timeout: 60000 });

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
  test('a job with neither credential names both, and says where the OIDC one went', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // GitLab supplies BEHINDGATE_OIDC_TOKEN from the `id_tokens:` block the
    // component puts on the job. Its absence means the job was redefined without
    // carrying that block over -- redefining REPLACES keys rather than merging
    // them -- which is not something the CLI could ever diagnose from inside.
    const result = await runComponent(makeWorkspace(), {
      BEHINDGATE_OIDC_TOKEN: '',
      BEHINDGATE_TOKEN: '',
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /has no credential/);
    assert.match(result.stderr, /id_tokens:/);
    assert.match(result.stderr, /BEHINDGATE_TOKEN/);
  });

  test('a malformed deploy token is reported as malformed, and never echoed', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const result = await runComponent(makeWorkspace(), { BEHINDGATE_TOKEN: 'not-a-jwt' });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not a well-formed JWT/);
    assert.ok(!result.output.includes('not-a-jwt'), 'the token value must never be echoed');
  });

  test('a deploy token takes precedence over OIDC, matching the CLI', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The CLI uses BEHINDGATE_TOKEN as-is whenever it is set, so the script has
    // to select the same credential the CLI will -- otherwise its diagnostics
    // describe a code path that did not run.
    const capture = await startCaptureServer();

    try {
      const result = await runComponent(makeWorkspace(), {
        BEHINDGATE_TOKEN: fakeJwt(),
        BG_URL: capture.url,
      });

      assert.equal(result.code, 0, `component failed:\n${result.output}`);
      assert.match(result.output, /Authenticating with BEHINDGATE_TOKEN/);
      assert.equal(capture.exchanges.length, 0, 'a deploy token needs no OIDC exchange');
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('a CLI too old for OIDC is refused before anything is downloaded', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // Older releases do not read BEHINDGATE_OIDC_TOKEN at all; they report the
    // absence of a deploy token instead, which sends you looking for a variable
    // you deliberately did not set.
    const before = downloads.requests.length;
    const result = await runComponent(makeWorkspace(), { BG_CLI_VERSION: '2026.8.4' });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /2026\.8\.4 cannot authenticate over OIDC/);
    assert.equal(downloads.requests.length, before, 'nothing may be fetched for a CLI that cannot');
  }, { timeout: 60000 });

  test('that same CLI is fine once a deploy token is supplied', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The version gate is about the credential, not about the release: 2026.8.4
    // deploys perfectly well with a deploy token, and refusing it outright would
    // remove the fallback the gate exists to point at.
    const result = await runComponent(makeWorkspace(), {
      BG_CLI_VERSION: '2026.8.4',
      BEHINDGATE_TOKEN: fakeJwt(),
      BG_PATH: 'no-such-dir',
    });

    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stderr, /cannot authenticate over OIDC/);
    assert.match(result.stderr, /does not exist in the job workspace/);
  }, { timeout: 60000 });

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

  test('an `app-origin` carrying a path is refused before anything is downloaded', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The deploy endpoint is built by appending to this value, and the same
    // value is the audience the token was minted for. A path here would produce
    // an address nobody named.
    const before = downloads.requests.length;
    const result = await runComponent(makeWorkspace(), {
      BG_APP_ORIGIN: 'https://app.behindgate.com/api/deploy/releases',
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /`app-origin` input .* is not a bare origin/);
    assert.match(result.stderr, /use the `url` input/);
    assert.equal(downloads.requests.length, before, 'nothing may be fetched for a bad origin');
  }, { timeout: 60000 });

  test('anything that is not an https origin is refused, http:// included', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // http:// is refused rather than warned about: this value is the audience
    // GitLab mints the job's OIDC token for, and that token is a bearer
    // credential. `env` never allowed a clear-text instance either.
    const corpus = [
      'app.behindgate.com',
      'prod',
      'ftp://app.behindgate.com',
      'https://',
      'http://app.behindgate.com',
      'http://localhost:3000',
    ];

    for (const value of corpus) {
      const result = await runComponent(makeWorkspace(), { BG_APP_ORIGIN: value });

      assert.notEqual(result.code, 0, `${value} must be refused`);
      assert.match(result.stderr, /is not an https:\/\/ origin|is not a bare origin/);
    }
  }, { timeout: 120000 });

  test('a trailing slash is refused rather than trimmed', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // GitLab mints `aud` from the raw input when it expands the configuration,
    // so by the time this shell runs the audience is already fixed. Trimming the
    // slash here would leave the derived endpoint disagreeing with the audience
    // the token actually carries -- tolerant-looking, and wrong. Refusing it is
    // the only outcome that keeps the two the same string.
    for (const value of [`${DEFAULT_ORIGIN}/`, `${DEFAULT_ORIGIN}//`]) {
      const result = await runComponent(makeWorkspace(), { BG_APP_ORIGIN: value });

      assert.notEqual(result.code, 0, `${value} must be refused`);
      assert.match(result.stderr, /is not a bare origin/);
      assert.match(result.stderr, /compared as an exact string/);
    }
  }, { timeout: 120000 });

  test('`url` wins over the endpoint `app-origin` derives', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // An explicit endpoint must never be replaced by one derived from a
    // shorthand. The default origin would send this to app.behindgate.com; the
    // upload landing on the capture server is the proof that it did not.
    const capture = await startCaptureServer();

    try {
      const result = await runComponent(makeWorkspace(), { BG_URL: capture.url });

      assert.equal(result.code, 0, `component failed:\n${result.output}`);
      assert.equal(capture.uploads.length, 1);
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('an instance that republishes builds says so', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const republishing = Object.values(ENVIRONMENTS).find((environment) => !environment.pinnedCli);
    const capture = await startCaptureServer();

    try {
      const result = await runComponent(makeWorkspace(), {
        BG_APP_ORIGIN: new URL(republishing.deployUrl).origin,
        BG_URL: capture.url,
      });

      assert.match(result.stderr, /republishes CLI builds under the same version/);
      assert.match(result.stderr, /means the build was replaced, not that anything is wrong/);
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });

  test('an instance this component does not name is allowed, but warned about', async (t) => {
    if (skipReason) return t.skip(skipReason);

    // The pin is what protects the download, and it is committed here rather
    // than served by the host -- so an unknown host cannot substitute a binary,
    // it can only fail verification. That makes a warning the right response
    // rather than a refusal, which would rule out local instances entirely.
    const capture = await startCaptureServer();

    try {
      const result = await runComponent(makeWorkspace(), {
        BG_APP_ORIGIN: 'https://behindgate.internal.example',
        BG_URL: capture.url,
      });

      assert.equal(result.code, 0, `component failed:\n${result.output}`);
      assert.match(result.stderr, /is not an instance this component knows about/);
      assert.match(result.stderr, /still verified against a checksum pinned here/);
    } finally {
      await capture.close();
    }
  }, { timeout: 120000 });
});
