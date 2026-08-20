'use strict';

/**
 * A local stand-in for the BehindGate download host.
 *
 * Serves `/downloads/<version>/<archive>` from bytes the caller supplies, so the
 * GitLab component's shell can be driven end to end -- download, checksum,
 * extract, execute -- without reaching the internet during the test.
 *
 * `corrupt` flips the served bytes so the checksum path can be exercised for
 * real rather than asserted about.
 */

const http = require('node:http');

/**
 * @param {Map<string, Buffer>} files keyed by `<version>/<archive>`
 * @returns {Promise<{url: string, requests: string[], corrupt: boolean, close: () => Promise<void>}>}
 */
function startDownloadServer(files) {
  const state = { corrupt: false };
  const requests = [];

  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    requests.push(pathname);

    const match = pathname.match(/^\/downloads\/(.+)$/);
    const body = match ? files.get(match[1]) : undefined;

    if (!body) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found\n');
      return;
    }

    const served = state.corrupt ? Buffer.concat([body, Buffer.from('tampered')]) : body;
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(served.length),
    });
    res.end(served);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        get corrupt() {
          return state.corrupt;
        },
        set corrupt(value) {
          state.corrupt = value;
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startDownloadServer };
