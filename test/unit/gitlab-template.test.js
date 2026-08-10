'use strict';

/**
 * The GitLab component is generated output, so these tests exist for the same
 * reason CI rebuilds `dist/`: what ships must correspond to reviewed source.
 *
 * The pin table is the part that matters. The component cannot read
 * versions.json at job time -- this repository is never checked out on a GitLab
 * runner -- so the checksums are inlined into the shipped YAML. A stale inline
 * copy would still verify, just against the wrong hash, and nothing at deploy
 * time would notice.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { build, generatePins, PLATFORMS } = require('../../script/build-gitlab-template');
const versions = require('../../src/core/versions');

const ROOT = path.join(__dirname, '..', '..');

// Normalised for the same reason the build normalises: `.gitattributes` asks for
// LF everywhere, but a working copy predating it can still hold CRLF, and these
// assertions are about content rather than about how someone's Git is set up.
const read = (relative) =>
  fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');

describe('the generated GitLab component', () => {
  test('the committed files match a fresh build', () => {
    for (const output of build()) {
      assert.equal(
        read(output.label),
        output.next,
        `${output.label} is out of date -- run 'npm run build:gitlab' and commit the result`
      );
    }
  });

  test('every pinned checksum matches versions.json', () => {
    const script = read('src/gitlab/deploy.sh');

    for (const version of versions.knownVersions()) {
      for (const platform of PLATFORMS) {
        const artifact = versions.resolveArtifact(version, platform);
        const line = `'${version}/${platform}') printf '%s %s %s\\n' '${artifact.archive}' '${artifact.binary}' '${artifact.sha256}' ;;`;
        assert.ok(
          script.includes(line),
          `deploy.sh does not pin ${version}/${platform} as versions.json describes it`
        );
      }
    }
  });

  test('the default version and download host come from versions.json', () => {
    const script = read('src/gitlab/deploy.sh');
    assert.ok(script.includes(`BG_DEFAULT_VERSION='${versions.defaultVersion()}'`));
    assert.ok(
      script.includes(`BG_DEFAULT_BASE_URL='${versions.defaultDownloadBaseUrl()}'`)
    );
  });

  test('the shipped template carries the pins, not just the source', () => {
    const template = read('templates/deploy.yml');

    for (const platform of PLATFORMS) {
      const { sha256 } = versions.resolveArtifact(versions.defaultVersion(), platform);
      assert.ok(template.includes(sha256), `templates/deploy.yml is missing the ${platform} pin`);
    }
  });

  test('no windows platform is pinned', () => {
    // GitLab's Windows runners use PowerShell, so the component's POSIX shell
    // cannot run there. A windows pin would be a checksum for an archive this
    // script could never fetch -- worse than absent, because it reads as
    // support and would fail only once someone tried it.
    assert.ok(!PLATFORMS.some((platform) => platform.startsWith('windows-')));
    assert.ok(!read('templates/deploy.yml').includes('windows-'));
  });

  test('the build refuses a version that is not pinned for every supported platform', () => {
    const table = {
      defaultVersion: '2026.9.0',
      defaultDownloadBaseUrl: 'https://app.behindgate.com',
      versions: {
        '2026.9.0': {
          platforms: {
            'linux-amd64': {
              archive: 'bg-deploy-linux-amd64.tar.gz',
              binary: 'bg-deploy',
              sha256: 'a'.repeat(64),
            },
          },
        },
      },
    };

    assert.throws(() => generatePins(table), /pins no "linux-arm64" artifact/);
  });

  test('the build refuses an archive format the shell cannot unpack', () => {
    const table = {
      defaultVersion: '2026.9.0',
      defaultDownloadBaseUrl: 'https://app.behindgate.com',
      versions: {
        '2026.9.0': {
          platforms: Object.fromEntries(
            PLATFORMS.map((platform) => [
              platform,
              { archive: `bg-deploy-${platform}.zip`, binary: 'bg-deploy', sha256: 'a'.repeat(64) },
            ])
          ),
        },
      },
    };

    assert.throws(() => generatePins(table), /cannot unpack/);
  });

  test('the build refuses values that would need shell quoting', () => {
    const table = {
      defaultVersion: "2026.9.0'; rm -rf /",
      defaultDownloadBaseUrl: 'https://app.behindgate.com',
      versions: {},
    };

    assert.throws(() => generatePins(table), /would need quoting/);
  });
});

describe('the component contract', () => {
  test('the token is never a component input', () => {
    // Inputs are interpolated into the pipeline configuration, which anyone able
    // to view the project's merged YAML can read. The token has to arrive as a
    // masked CI/CD variable instead, and this test is what stops a future input
    // named `token` from quietly making it visible.
    const spec = read('templates/deploy.yml').split('\n---')[0];
    const names = [...spec.matchAll(/^ {4}([a-z0-9-]+):$/gm)].map((match) => match[1]);

    assert.ok(names.length >= 4, 'expected to find the component inputs');
    for (const name of names) {
      assert.ok(
        !/token|secret|password|credential/.test(name),
        `"${name}" looks like a credential and must not be a component input`
      );
    }
  });

  test('the deploy path and endpoint reach the script as variables, not as script text', () => {
    // Pasting `$[[ inputs.path ]]` straight into the shell body would make a
    // value containing a quote into shell syntax. Passing it through `variables:`
    // keeps it data.
    const template = read('templates/deploy.yml');
    const [, job] = template.split('\n---');

    assert.match(job, /BG_PATH: \$\[\[ inputs\.path \]\]/);
    assert.match(job, /BG_URL: \$\[\[ inputs\.url \]\]/);

    const script = job.slice(job.indexOf('script:'));
    assert.ok(!script.includes('$[[ inputs.'), 'no input may be interpolated into the script body');
  });

  test('the job publishes a dotenv report, the GitLab analogue of an output', () => {
    const template = read('templates/deploy.yml');
    assert.match(template, /dotenv: behindgate\.env/);
    assert.match(template, /BEHINDGATE_RELEASE_ID=/);
    assert.match(template, /BEHINDGATE_URL=/);
  });

  test('only the archive is cached, never the extracted binary', () => {
    // A runner cache is shared and writable by other jobs, so a cached binary
    // would be executed on trust. A cached archive is re-hashed against the pin
    // on every run, which makes it exactly as trustworthy as a fresh download.
    const template = read('templates/deploy.yml');
    assert.match(template, /paths:\n\s+- \.bg-deploy-cache\/\n/);
    assert.ok(!template.includes('- .bg-deploy-run'));
  });
});
