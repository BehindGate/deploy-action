'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveInputs,
  parseBoolean,
  parseTags,
  ConfigurationError,
} = require('../../src/core/inputs');
const {
  resolveEnvironment,
  knownEnvironments,
  isKnownDownloadOrigin,
  ENVIRONMENTS,
  KNOWN_DOWNLOAD_ORIGINS,
  UnknownEnvironmentError,
} = require('../../src/core/environments');
const versions = require('../../src/core/versions');
const { fakeJwt } = require('../helpers/capture-server');

const TOKEN = fakeJwt();

/** The inputs a plain token deploy supplies; individual tests vary one at a time. */
function inputs(overrides = {}) {
  return resolveInputs({ path: 'dist', token: TOKEN, ...overrides });
}

describe('environments', () => {
  test('prod is the default and carries both URLs', () => {
    const resolved = resolveEnvironment('');
    assert.equal(resolved.name, 'prod');
    assert.equal(resolved.deployUrl, 'https://app.behindgate.com/api/deploy/releases');
    assert.equal(resolved.downloadBaseUrl, 'https://app.behindgate.com');
  });

  test('test resolves to the test host, on .net', () => {
    const resolved = resolveEnvironment('test');
    assert.equal(resolved.deployUrl, 'https://app.test.behindgate.net/api/deploy/releases');
    assert.equal(resolved.downloadBaseUrl, 'https://app.test.behindgate.net');
  });

  test('the deploy endpoint names the releases collection, not the host', () => {
    // The CLI posts to --url verbatim to create a release, so this has to be the
    // releases collection: the parent would put creation on the wrong route, and
    // the bare host is fronted by a CDN that answers a POST with 403 text/html.
    // The sibling routes (oidc/token, apps, publish) come off the segment above,
    // so they land on /api/deploy/... either way.
    for (const environment of Object.values(ENVIRONMENTS)) {
      assert.ok(
        environment.deployUrl.startsWith(`${environment.downloadBaseUrl}/`),
        `${environment.name}: the endpoint should live under its own host`
      );
      assert.notEqual(environment.deployUrl, environment.downloadBaseUrl);
      assert.match(environment.deployUrl, /\/api\/deploy\/releases$/);
    }
  });

  test('an unknown environment is refused rather than treated as the default', () => {
    for (const value of ['staging', 'production', 'PROD ', 'dev']) {
      if (value.trim().toLowerCase() === 'prod') continue;
      assert.throws(() => resolveEnvironment(value), UnknownEnvironmentError, value);
    }
  });

  test('the name is matched case-insensitively', () => {
    assert.equal(resolveEnvironment('TEST').name, 'test');
    assert.equal(resolveEnvironment(' test ').name, 'test');
  });

  test('the error names the values that would have worked', () => {
    try {
      resolveEnvironment('staging');
      assert.fail('expected a throw');
    } catch (error) {
      for (const name of knownEnvironments()) assert.match(error.message, new RegExp(name));
    }
  });

  test('only prod is described by the committed pins', () => {
    // versions.json was captured from production, which publishes a version once.
    // Test republishes, so a pin there describes a build until someone rebuilds
    // it -- the CLI is verified against the host's own manifest instead.
    assert.equal(ENVIRONMENTS.prod.pinnedCli, true);
    assert.equal(ENVIRONMENTS.test.pinnedCli, false);
    assert.equal(resolveEnvironment('').pinnedCli, true);
  });

  test('the known download origins are exactly the environments\' hosts', () => {
    assert.deepEqual(
      [...KNOWN_DOWNLOAD_ORIGINS].sort(),
      Object.values(ENVIRONMENTS)
        .map((environment) => environment.downloadBaseUrl)
        .sort()
    );
  });

  test("prod's download host is the one the pinned checksums came from", () => {
    // A checksum only means something relative to whoever served it. If
    // versions.json ever moves its default host, `env: prod` must move with it
    // or the pins would be verified against a host they never described.
    assert.equal(ENVIRONMENTS.prod.downloadBaseUrl, versions.defaultDownloadBaseUrl());
  });
});

describe('isKnownDownloadOrigin', () => {
  // Consulted only where the checksum comes from the download host itself: the
  // host then decides both the bytes and the digest they should match, which is
  // tolerable from a host named in this repository and not from one an input
  // picked.
  test('accepts a URL under either environment host', () => {
    assert.equal(isKnownDownloadOrigin('https://app.behindgate.com/downloads/index.json'), true);
    assert.equal(
      isKnownDownloadOrigin('https://app.test.behindgate.net/downloads/2026.8.5/SHA256SUMS.txt'),
      true
    );
  });

  test('refuses another host, however similar', () => {
    for (const url of [
      'https://app.behindgate.com.evil.example/downloads/index.json',
      'https://evil.example/app.behindgate.com/downloads/index.json',
      'https://app.behindgate.net/downloads/index.json',
      'https://localhost:8080/downloads/index.json',
    ]) {
      assert.equal(isKnownDownloadOrigin(url), false, url);
    }
  });

  test('refuses a downgraded scheme on a known host', () => {
    // Same host, different origin: a plaintext fetch of the file that decides
    // which bytes are acceptable is not the same request.
    const downgraded = ENVIRONMENTS.test.downloadBaseUrl.replace(/^https:/, 'http:');
    assert.equal(isKnownDownloadOrigin(`${downgraded}/downloads/index.json`), false);
  });

  test('refuses anything that is not a URL at all', () => {
    assert.equal(isKnownDownloadOrigin('nonsense'), false);
    assert.equal(isKnownDownloadOrigin(''), false);
    assert.equal(isKnownDownloadOrigin(undefined), false);
  });
});

describe('env resolves both URLs', () => {
  test('env: test switches the endpoint and the download host together', () => {
    const resolved = inputs({ env: 'test' });
    assert.equal(resolved.deployUrl, 'https://app.test.behindgate.net/api/deploy/releases');
    assert.equal(resolved.downloadBaseUrl, 'https://app.test.behindgate.net');
    assert.deepEqual(resolved.args, [
      '-y',
      '--json',
      '--url',
      'https://app.test.behindgate.net/api/deploy/releases',
      'dist',
    ]);
  });

  test('an unset env deploys to production', () => {
    const resolved = inputs();
    assert.equal(resolved.deployUrl, 'https://app.behindgate.com/api/deploy/releases');
    assert.equal(resolved.downloadBaseUrl, 'https://app.behindgate.com');
    assert.equal(resolved.endpointSource, 'the prod default');
  });

  test('an unknown env fails instead of falling through to the default', () => {
    assert.throws(() => inputs({ env: 'staging' }), UnknownEnvironmentError);
  });
});

describe('url and download-base-url win over env', () => {
  test('an explicit url overrides the environment endpoint', () => {
    const resolved = inputs({ env: 'test', url: 'http://127.0.0.1:8080/api/deploy' });
    assert.equal(resolved.deployUrl, 'http://127.0.0.1:8080/api/deploy');
    assert.equal(resolved.endpointSource, 'the `url` input');
    assert.ok(resolved.args.includes('http://127.0.0.1:8080/api/deploy'));
    assert.ok(!resolved.args.includes('https://app.test.behindgate.net/api/deploy/releases'));
  });

  test('overriding the endpoint leaves the download host on the environment', () => {
    // The two are independent: a local endpoint does not imply a local mirror
    // of the CLI archives.
    const resolved = inputs({ env: 'test', url: 'http://127.0.0.1:8080/api/deploy' });
    assert.equal(resolved.downloadBaseUrl, 'https://app.test.behindgate.net');
  });

  test('an explicit download-base-url overrides the environment host', () => {
    const resolved = inputs({ env: 'test', downloadBaseUrl: 'https://mirror.example.com' });
    assert.equal(resolved.downloadBaseUrl, 'https://mirror.example.com');
    assert.equal(resolved.deployUrl, 'https://app.test.behindgate.net/api/deploy/releases');
  });

  test('a workflow written before env existed keeps its exact behaviour', () => {
    const resolved = inputs({
      url: 'https://app.behindgate.com/api/deploy/releases',
      downloadBaseUrl: 'https://app.behindgate.com',
    });
    assert.equal(resolved.deployUrl, 'https://app.behindgate.com/api/deploy/releases');
    assert.equal(resolved.downloadBaseUrl, 'https://app.behindgate.com');
  });
});

describe('credentials', () => {
  test('a token is passed through, and its mode is reported', () => {
    const resolved = inputs();
    assert.equal(resolved.token, TOKEN);
    assert.equal(resolved.usesToken, true);
  });

  test('no token selects the CI-job credential', () => {
    const resolved = resolveInputs({ path: 'dist' });
    assert.equal(resolved.usesToken, false);
    assert.equal(resolved.token, '');
  });

  test('a token that is not a JWT is rejected, without echoing it', () => {
    assert.throws(
      () => inputs({ token: 'ghp_notatoken' }),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /well-formed JWT/);
        assert.ok(!error.message.includes('ghp_notatoken'), 'the value must not be echoed');
        return true;
      }
    );
  });

  test('surrounding whitespace on a secret is tolerated', () => {
    assert.equal(inputs({ token: `\n  ${TOKEN}  \n` }).token, TOKEN);
  });
});

describe('token and site-url are mutually exclusive', () => {
  test('passing both is a configuration error', () => {
    assert.throws(
      () => inputs({ siteUrl: 'https://docs.example.com/preview/pr-1' }),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /either `token` or `site-url`/);
        return true;
      }
    );
  });

  test('the failure happens before anything is downloaded or run', () => {
    // resolveInputs is called before the CLI is acquired, so the whole
    // invocation is refused rather than half-performed.
    assert.throws(
      () => inputs({ siteUrl: 'https://docs.example.com/preview/pr-1', env: 'test' }),
      ConfigurationError
    );
  });

  test('site-url alone, with the CI-job credential, is fine', () => {
    const resolved = resolveInputs({
      path: 'dist',
      siteUrl: 'https://docs.example.com/preview/pr-1',
    });
    assert.deepEqual(resolved.args, [
      '-y',
      '--json',
      '--url',
      'https://app.behindgate.com/api/deploy/releases',
      '--site-url',
      'https://docs.example.com/preview/pr-1',
      'dist',
    ]);
  });
});

describe('create-app and delete-app', () => {
  const preview = { siteUrl: 'https://docs.example.com/preview/pr-42' };

  test('create-app reaches the CLI as --create-app, with the path last', () => {
    const resolved = resolveInputs({ path: 'dist', createApp: 'true', ...preview });
    assert.deepEqual(resolved.args, [
      '-y',
      '--json',
      '--url',
      'https://app.behindgate.com/api/deploy/releases',
      '--site-url',
      'https://docs.example.com/preview/pr-42',
      '--create-app',
      'dist',
    ]);
  });

  test('delete-app reaches the CLI as --delete-app, and takes no path', () => {
    const resolved = resolveInputs({ deleteApp: 'true', env: 'test', ...preview });
    assert.deepEqual(resolved.args, [
      '-y',
      '--json',
      '--url',
      'https://app.test.behindgate.net/api/deploy/releases',
      '--site-url',
      'https://docs.example.com/preview/pr-42',
      '--delete-app',
    ]);
    assert.equal(resolved.deployPath, '');
  });

  test('false leaves both flags off', () => {
    const resolved = resolveInputs({
      path: 'dist',
      createApp: 'false',
      deleteApp: 'false',
      ...preview,
    });
    assert.ok(!resolved.args.includes('--create-app'));
    assert.ok(!resolved.args.includes('--delete-app'));
  });

  test('a path given to a teardown is ignored, with a warning', () => {
    const resolved = resolveInputs({ path: 'dist', deleteApp: 'true', ...preview });
    assert.ok(!resolved.args.includes('dist'));
    assert.equal(resolved.warnings.length, 1);
    assert.match(resolved.warnings[0], /ignored/);
  });

  test('neither works with a deploy token, which is pinned to one existing app', () => {
    for (const flag of ['createApp', 'deleteApp']) {
      assert.throws(
        () => resolveInputs({ path: 'dist', token: TOKEN, [flag]: 'true' }),
        (error) => {
          assert.ok(error instanceof ConfigurationError);
          assert.match(error.message, /id-token: write/);
          return true;
        },
        flag
      );
    }
  });

  test('both at once is refused', () => {
    assert.throws(
      () => resolveInputs({ path: 'dist', createApp: 'true', deleteApp: 'true', ...preview }),
      ConfigurationError
    );
  });

  test('each needs site-url to name the app', () => {
    for (const flag of ['createApp', 'deleteApp']) {
      assert.throws(
        () => resolveInputs({ path: 'dist', [flag]: 'true' }),
        (error) => {
          assert.match(error.message, /needs `site-url`/);
          return true;
        },
        flag
      );
    }
  });
});

describe('path', () => {
  test('is required for a deploy', () => {
    assert.throws(() => resolveInputs({ token: TOKEN }), /`path` input is required/);
  });

  test('is not required for a teardown', () => {
    assert.doesNotThrow(() =>
      resolveInputs({ deleteApp: 'true', siteUrl: 'https://docs.example.com/preview/pr-1' })
    );
  });
});

describe('parseBoolean', () => {
  test('accepts true and false in any case', () => {
    assert.equal(parseBoolean('create-app', 'true'), true);
    assert.equal(parseBoolean('create-app', 'TRUE'), true);
    assert.equal(parseBoolean('create-app', ' False '), false);
  });

  test('an empty input falls back', () => {
    assert.equal(parseBoolean('create-app', ''), false);
    assert.equal(parseBoolean('create-app', undefined), false);
  });

  test('rejects anything else rather than reading it as false', () => {
    // A `delete-app: yes` silently read as false leaves preview apps behind
    // forever while the job goes green.
    for (const value of ['yes', 'no', '1', '0', 'on']) {
      assert.throws(() => parseBoolean('delete-app', value), ConfigurationError, value);
    }
  });
});

describe('tags', () => {
  test('one per line, as name=value or a bare name', () => {
    const resolved = inputs({ tags: 'sha=abc123\nnightly\n' });
    assert.deepEqual(resolved.tags, [
      { name: 'sha', value: 'abc123', raw: 'sha=abc123' },
      { name: 'nightly', value: '', raw: 'nightly' },
    ]);
    assert.deepEqual(resolved.args.slice(-3), ['--tag', 'nightly', 'dist']);
  });

  test('a value keeps everything after the first =', () => {
    const [tag] = parseTags('subject=fix: keep a=b in the message');
    assert.equal(tag.value, 'fix: keep a=b in the message');
  });

  test('a name with nothing after the = stays a bare marker', () => {
    // A CI expression that resolves to nothing (an unset build number) labels
    // the release rather than failing the step.
    assert.deepEqual(parseTags('build='), [{ name: 'build', value: '', raw: 'build' }]);
  });

  test('blank lines and surrounding space are not tags', () => {
    assert.deepEqual(parseTags('\n  sha = abc  \n\n'), [
      { name: 'sha', value: 'abc', raw: 'sha=abc' },
    ]);
    assert.deepEqual(parseTags(''), []);
    assert.deepEqual(parseTags(undefined), []);
  });

  test('a name the API would reject is an input error, not a failed deploy', () => {
    for (const value of ['1sha=abc', '=abc', 'a b=c', 'sha/1=abc']) {
      assert.throws(() => parseTags(value), ConfigurationError, value);
    }
  });

  test('a repeated name is refused, whatever its case', () => {
    assert.throws(() => parseTags('sha=abc\nSHA=def'), /given more than once/);
  });

  test('a teardown drops them, with a warning', () => {
    const resolved = resolveInputs({
      deleteApp: 'true',
      siteUrl: 'https://docs.example.com/preview/pr-1',
      tags: 'sha=abc123',
    });
    assert.deepEqual(resolved.tags, []);
    assert.ok(!resolved.args.includes('--tag'));
    assert.ok(resolved.warnings.some((warning) => warning.includes('`tags` is ignored')));
  });
});

describe('trust', () => {
  test('is passed through as --trust', () => {
    const resolved = resolveInputs({
      path: 'dist',
      trust: 'trust_01J8',
      siteUrl: 'https://docs.example.com/preview/pr-1',
    });
    assert.equal(resolved.trust, 'trust_01J8');
    assert.deepEqual(resolved.args.slice(4, 6), ['--trust', 'trust_01J8']);
  });

  test('cannot be combined with a token', () => {
    // The CLI ignores it there, so the deploy would go wherever the token says
    // while the workflow reads as if the trust selected the target.
    assert.throws(() => inputs({ trust: 'trust_01J8' }), /`token` or `trust`, not both/);
  });

  test('is absent from the command line when unset', () => {
    assert.ok(!inputs().args.includes('--trust'));
  });
});
