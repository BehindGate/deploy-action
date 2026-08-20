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

const {
  build,
  generatePins,
  generateOrigins,
  oidcCapableVersions,
  compareVersions,
  PLATFORMS,
  OIDC_MIN_VERSION,
  DEPLOY_PATH,
} = require('../../script/build-gitlab-template');
const versions = require('../../src/core/versions');
const { ENVIRONMENTS } = require('../../src/core/environments');

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

  test('the default version is the newest release that can authenticate over OIDC', () => {
    // Deliberately NOT versions.json's own defaultVersion, which belongs to the
    // Action: that one still has the deploy token as its default credential and
    // must keep pointing at what production serves. The component authenticates
    // as the job unless a token is set, so its default has to be able to.
    const script = read('src/gitlab/deploy.sh');
    const capable = oidcCapableVersions(versions.DEFAULT_TABLE);

    assert.ok(capable.length, 'versions.json must pin an OIDC-capable release');
    assert.ok(script.includes(`BG_DEFAULT_VERSION='${capable[capable.length - 1]}'`));
    assert.ok(script.includes(`BG_OIDC_VERSIONS='${capable.join(' ')}'`));
    assert.ok(script.includes(`BG_OIDC_MIN_VERSION='${OIDC_MIN_VERSION}'`));
  });

  test('the OIDC-capable set is decided numerically, not as strings', () => {
    // The vendor's versions are calendar, not semver: 2026.8.10 has to sort
    // above 2026.8.9, which a string comparison gets backwards.
    assert.ok(compareVersions('2026.8.10', '2026.8.9') > 0);
    assert.ok(compareVersions('2026.8.5', '2026.8.5') === 0);
    assert.ok(compareVersions('2026.10.0', '2026.9.0') > 0);

    const table = {
      versions: { '2026.8.4': {}, '2026.8.9': {}, '2026.8.10': {} },
    };
    assert.deepEqual(oidcCapableVersions(table), ['2026.8.9', '2026.8.10']);
  });

  test('the endpoint the script derives matches what the Action resolves', () => {
    // The component builds its endpoint as <app-origin> + BG_DEPLOY_PATH rather
    // than reading a table of them. That is only safe while the two agree, and
    // generateOrigins refuses to build if they ever stop.
    const script = read('src/gitlab/deploy.sh');

    for (const environment of Object.values(ENVIRONMENTS)) {
      const origin = new URL(environment.deployUrl).origin;
      assert.equal(`${origin}${DEPLOY_PATH}`, environment.deployUrl);
      assert.ok(
        script.includes(`'${origin}') printf '%s\\n' '${environment.pinnedCli ? 'pinned' : 'unpinned'}'`),
        `deploy.sh does not record whether ${origin} republishes its builds`
      );
    }
  });

  test('the build refuses an environment whose addresses it could not derive', () => {
    assert.throws(
      () =>
        generateOrigins({
          odd: {
            deployUrl: 'https://app.example.com/v2/releases',
            downloadBaseUrl: 'https://app.example.com',
            pinnedCli: true,
          },
        }),
      /could not be reached that way/
    );

    assert.throws(
      () =>
        generateOrigins({
          split: {
            deployUrl: `https://app.example.com${DEPLOY_PATH}`,
            downloadBaseUrl: 'https://downloads.example.com',
            pinnedCli: true,
          },
        }),
      /cannot express a split like that/
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
    const platforms = Object.fromEntries(
      PLATFORMS.map((platform) => [
        platform,
        { archive: `bg-deploy-${platform}.tar.gz`, binary: 'bg-deploy', sha256: 'a'.repeat(64) },
      ])
    );

    const table = {
      versions: {
        '2026.9.0': { platforms },
        "2026.9.1'; rm -rf /": { platforms },
      },
    };

    assert.throws(() => generatePins(table), /would need quoting/);
  });

  test('the build refuses a table with nothing that can authenticate over OIDC', () => {
    // The component's default credential is the job's own OIDC token, so a pin
    // table that cannot supply a CLI able to exchange one would generate a
    // component whose default configuration is unusable.
    const table = {
      versions: {
        '2026.8.0': {
          platforms: Object.fromEntries(
            PLATFORMS.map((platform) => [
              platform,
              { archive: `bg-deploy-${platform}.tar.gz`, binary: 'bg-deploy', sha256: 'a'.repeat(64) },
            ])
          ),
        },
      },
    };

    assert.throws(() => generatePins(table), /pins nothing at or above/);
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

  test('the job declares an id_token whose audience is the instance it deploys to', () => {
    // The audience is what the CI trust checks, and a token minted for one
    // audience cannot be exchanged at another. Both come from `app-origin`, so
    // they cannot be set to disagree -- which is the entire reason the component
    // takes an origin rather than an endpoint.
    const [, job] = read('templates/deploy.yml').split('\n---');

    assert.match(job, /^ {2}id_tokens:$/m);
    assert.match(job, /^ {4}BEHINDGATE_OIDC_TOKEN:$/m);
    assert.match(job, /^ {6}aud: \$\[\[ inputs\.app-origin \]\]$/m);
  });

  test('the component takes an origin, not an environment name', () => {
    // `env` would have to resolve in the shell, while `aud:` resolves when the
    // configuration is expanded -- so an environment shorthand could only drive
    // the audience by declaring one id_token per environment, minting every job
    // a credential for an instance it does not deploy to.
    const spec = read('templates/deploy.yml').split('\n---')[0];

    assert.match(spec, /^ {4}app-origin:$/m);
    assert.ok(!/^ {4}env:$/m.test(spec), 'the `env` input was replaced by `app-origin`');
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

  test('the job declares nothing that would write to the project directory', () => {
    // `cache:` and `artifacts:` can only name paths inside $CI_PROJECT_DIR, and
    // `path: .` deploys that directory -- so anything either one produced would
    // be published as part of the user's site. The component keeps its scratch
    // files in a temporary directory instead.
    const [, job] = read('templates/deploy.yml').split('\n---');

    assert.ok(!/^\s{2}cache:/m.test(job), 'a cache would have to live in the project directory');
    assert.ok(!/^\s{2}artifacts:/m.test(job), 'an artifact would have to live in the project directory');
    assert.ok(!job.includes('behindgate.env'), 'no dotenv report may be written');
    assert.ok(!job.includes('.bg-deploy-cache'), 'no scratch directory may be created');
  });

  test('the script keeps its working files under a scratch directory it removes', () => {
    const script = read('src/gitlab/deploy.sh');

    // Outside the project directory, and chosen rather than assumed: the CLI is
    // executed from it, so it has to allow execution.
    assert.match(script, /BG_TMP=\$\(bg_scratch "\$\{CI_BUILDS_DIR:-\}" "\$\{TMPDIR:-\/tmp\}"\)/);
    assert.match(script, /trap 'rm -rf "\$BG_TMP"' EXIT/);
  });
});
