'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { resolveInputs, parseBoolean, ConfigurationError } = require('../../src/core/inputs');
const {
  resolveEnvironment,
  knownEnvironments,
  ENVIRONMENTS,
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
    assert.equal(resolved.deployUrl, 'https://app.behindgate.com/api/deploy');
    assert.equal(resolved.downloadBaseUrl, 'https://app.behindgate.com');
  });

  test('test resolves to the test host, on .net', () => {
    const resolved = resolveEnvironment('test');
    assert.equal(resolved.deployUrl, 'https://app.test.behindgate.net/api/deploy');
    assert.equal(resolved.downloadBaseUrl, 'https://app.test.behindgate.net');
  });

  test('the deploy endpoint is not the bare host', () => {
    // The host on its own is fronted by a CDN that answers a POST with 403
    // text/html, and the CLI sends its request to --url verbatim rather than
    // appending a path. A bare host would fail every deploy.
    for (const environment of Object.values(ENVIRONMENTS)) {
      assert.ok(
        environment.deployUrl.startsWith(`${environment.downloadBaseUrl}/`),
        `${environment.name}: the endpoint should live under its own host`
      );
      assert.notEqual(environment.deployUrl, environment.downloadBaseUrl);
      assert.match(environment.deployUrl, /\/api\/deploy$/);
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

  test("prod's download host is the one the pinned checksums came from", () => {
    // A checksum only means something relative to whoever served it. If
    // versions.json ever moves its default host, `env: prod` must move with it
    // or the pins would be verified against a host they never described.
    assert.equal(ENVIRONMENTS.prod.downloadBaseUrl, versions.defaultDownloadBaseUrl());
  });
});

describe('env resolves both URLs', () => {
  test('env: test switches the endpoint and the download host together', () => {
    const resolved = inputs({ env: 'test' });
    assert.equal(resolved.deployUrl, 'https://app.test.behindgate.net/api/deploy');
    assert.equal(resolved.downloadBaseUrl, 'https://app.test.behindgate.net');
    assert.deepEqual(resolved.args, [
      '-y',
      '--json',
      '--url',
      'https://app.test.behindgate.net/api/deploy',
      'dist',
    ]);
  });

  test('an unset env deploys to production', () => {
    const resolved = inputs();
    assert.equal(resolved.deployUrl, 'https://app.behindgate.com/api/deploy');
    assert.equal(resolved.downloadBaseUrl, 'https://app.behindgate.com');
    assert.equal(resolved.endpointSource, 'env: prod');
  });

  test('an unknown env fails instead of falling through to the default', () => {
    assert.throws(() => inputs({ env: 'staging' }), UnknownEnvironmentError);
  });
});

describe('url and download-base-url win over env', () => {
  test('an explicit url overrides the environment endpoint', () => {
    const resolved = inputs({ env: 'test', url: 'http://127.0.0.1:8080/api/deploy' });
    assert.equal(resolved.deployUrl, 'http://127.0.0.1:8080/api/deploy');
    assert.equal(resolved.endpointSource, 'url');
    assert.ok(resolved.args.includes('http://127.0.0.1:8080/api/deploy'));
    assert.ok(!resolved.args.includes('https://app.test.behindgate.net/api/deploy'));
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
    assert.equal(resolved.deployUrl, 'https://app.test.behindgate.net/api/deploy');
  });

  test('a workflow written before env existed keeps its exact behaviour', () => {
    const resolved = inputs({
      url: 'https://app.behindgate.com/api/deploy',
      downloadBaseUrl: 'https://app.behindgate.com',
    });
    assert.equal(resolved.deployUrl, 'https://app.behindgate.com/api/deploy');
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
      'https://app.behindgate.com/api/deploy',
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
      'https://app.behindgate.com/api/deploy',
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
      'https://app.test.behindgate.net/api/deploy',
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
