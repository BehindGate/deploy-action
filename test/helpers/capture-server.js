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
 */

const http = require('node:http');

/**
 * @returns {Promise<{url: string, requests: object[], uploads: Buffer[], close: () => Promise<void>}>}
 */
function startCaptureServer(options = {}) {
  const {
    releaseId = 'rel_test_0001',
    liveUrl = 'https://demo.test.behindgate.net/my-app/',
    pollsBeforeReady = 1,
    failCreateWith = null,
  } = options;

  const requests = [];
  const uploads = [];
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

module.exports = { startCaptureServer, fakeJwt };
