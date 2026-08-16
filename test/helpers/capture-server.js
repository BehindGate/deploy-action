'use strict';

/**
 * A local stand-in for the BehindGate deploy API.
 *
 * This is the technique that mapped the protocol in the first place: point the
 * real CLI at it with `--url` and a syntactically valid but fake JWT, and every
 * request the CLI makes is recorded. It needs no credentials, so it runs on
 * forks and in every CI job.
 *
 * Observed protocol (bg-deploy 2026.07.1):
 *   POST <url>            -> 201 {releaseId, uploadUrl, uploadMethod, expiresAt, url}
 *   PUT  <uploadUrl>      -> the zip, Content-Type: application/zip
 *   GET  <url>/<releaseId> -> polled until status is no longer "extracting"
 *   POST <url>/publish    -> {"releaseId": "..."}
 *
 * Added in 2026.8.5, for a job that authenticates as itself rather than with a
 * deploy token (`--site-url`, `--create-app`, `--delete-app`):
 *   POST   <url>/oidc/token -> form-encoded RFC 8693 exchange of the runner's
 *                              OIDC token; answers {access_token, ...}
 *   GET    <url>/apps       -> the apps the trust can see: {appId, pathPrefix, ...},
 *                              matched against the path half of --site-url
 *   POST   <url>/apps       -> {"name", "pathPrefix"} to create one
 *   DELETE <url>/apps/<id>  -> 204 to tear one down
 */

const http = require('node:http');

/**
 * @returns {Promise<{url: string, requests: object[], uploads: Buffer[], apps: object[], created: object[], deleted: string[], exchanges: object[], close: () => Promise<void>}>}
 */
function startCaptureServer(options = {}) {
  const {
    releaseId = 'rel_test_0001',
    liveUrl = 'https://demo.test.behindgate.net/my-app/',
    pollsBeforeReady = 1,
    failCreateWith = null,
    apps = [],
  } = options;

  const requests = [];
  const uploads = [];
  const created = [];
  const deleted = [];
  const exchanges = [];
  let polls = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const pathname = req.url.split('?')[0];

      requests.push({
        method: req.method,
        path: pathname,
        headers: req.headers,
        body,
        bodyText: body.length < 4096 ? body.toString('utf8') : undefined,
      });

      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload === undefined ? '' : JSON.stringify(payload));
      };

      const base = `http://127.0.0.1:${server.address().port}`;

      // 0a. exchange the runner's OIDC token for a short-lived deploy token
      if (req.method === 'POST' && pathname.endsWith('/oidc/token')) {
        const form = new URLSearchParams(body.toString('utf8'));
        exchanges.push(Object.fromEntries(form));
        return send(200, {
          access_token: fakeJwt({ url: base }),
          token_type: 'Bearer',
          expires_in: 900,
        });
      }

      // 0b. resolve --site-url against the apps the trust can see
      if (req.method === 'GET' && pathname.endsWith('/apps')) {
        return send(200, apps);
      }

      if (req.method === 'POST' && pathname.endsWith('/apps')) {
        const app = JSON.parse(body.toString('utf8'));
        created.push(app);
        // The CLI resolves an app by `pathPrefix` and addresses it by `appId`.
        const record = { appId: `app_${created.length}`, ...app };
        apps.push(record);
        return send(201, record);
      }

      if (req.method === 'DELETE' && pathname.includes('/apps/')) {
        deleted.push(pathname.slice(pathname.lastIndexOf('/') + 1));
        res.writeHead(204);
        return res.end();
      }

      // 1. create a release
      if (req.method === 'POST' && !pathname.endsWith('/publish') && !pathname.startsWith('/upload/')) {
        if (failCreateWith) return send(failCreateWith, { error: 'nope' });
        return send(201, {
          releaseId,
          uploadUrl: `${base}/upload/${releaseId}`,
          uploadMethod: 'PUT',
          expiresAt: '2030-01-01T00:00:00Z',
          url: liveUrl,
        });
      }

      // 2. receive the archive
      if (req.method === 'PUT' && pathname.startsWith('/upload/')) {
        uploads.push(body);
        return send(200, { ok: true });
      }

      // 4. publish
      if (req.method === 'POST' && pathname.endsWith('/publish')) {
        return send(200, { releaseId, status: 'published', url: liveUrl });
      }

      // 3. poll for extraction
      if (req.method === 'GET') {
        polls += 1;
        const ready = polls > pollsBeforeReady;
        return send(200, {
          releaseId,
          status: ready ? 'ready' : 'extracting',
          state: ready ? 'ready' : 'extracting',
          url: liveUrl,
        });
      }

      send(404, { error: 'unhandled', method: req.method, path: pathname });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        requests,
        uploads,
        apps,
        created,
        deleted,
        exchanges,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * A stand-in for the GitHub Actions token service.
 *
 * Without a deploy token the CLI asks the runner for an OIDC token and exchanges
 * it, which is the credential mode `--create-app` and `--delete-app` require.
 * `env()` returns the variables the real runner exports when a job is granted
 * `id-token: write`, so the CLI takes that path against a local server.
 *
 * @returns {Promise<{url: string, requests: object[], env: () => object, close: () => Promise<void>}>}
 */
function startActionsOidcProvider(options = {}) {
  const { token = fakeJwt({ iss: 'https://token.actions.githubusercontent.com' }) } = options;
  const requests = [];

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ value: token, count: 1 }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/token`;
      resolve({
        url,
        requests,
        env: () => ({
          GITHUB_ACTIONS: 'true',
          ACTIONS_ID_TOKEN_REQUEST_URL: url,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-request-token',
        }),
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

/**
 * A syntactically valid JWT with a fake signature.
 *
 * Enough to get past the CLI's structural check without being a credential for
 * anything. `url` is the endpoint claim the CLI falls back to when `--url` is
 * absent, which is what makes the redirect behaviour testable.
 */
function fakeJwt(claims = {}) {
  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url').replace(/=+$/, '');
  const header = encode({ alg: 'none', typ: 'JWT' });
  const payload = encode({ app: 'test-app', exp: 4102444800, ...claims });
  return `${header}.${payload}.ZmFrZXNpZ25hdHVyZQ`;
}

module.exports = { startCaptureServer, startActionsOidcProvider, fakeJwt };
