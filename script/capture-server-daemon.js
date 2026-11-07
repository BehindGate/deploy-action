#!/usr/bin/env node
'use strict';

/**
 * Runs the tests' capture server as a standalone process, so a workflow job can
 * point the Action at it.
 *
 * The in-process helper keeps its recordings in memory, which a job cannot read.
 * This publishes the address and a usable token to `$GITHUB_ENV`, then writes
 * what it recorded to `$CAPTURE_REQUESTS` when it is asked to stop.
 */

const fs = require('node:fs');
const { startCaptureServer, fakeJwt } = require('../test/helpers/capture-server');

async function main() {
  const server = await startCaptureServer();
  const token = fakeJwt({ url: server.url });

  const envFile = process.env.GITHUB_ENV;
  if (envFile) {
    fs.appendFileSync(envFile, `CAPTURE_URL=${server.url}\nCAPTURE_TOKEN=${token}\n`);
  }
  process.stdout.write(`${server.url}\n`);

  const dump = () => {
    const out = process.env.CAPTURE_REQUESTS;
    if (out) {
      const requests = server.requests.map(({ method, path, bodyText }) => ({
        method,
        path,
        bodyText,
      }));
      fs.writeFileSync(out, JSON.stringify(requests, null, 2));
    }
    process.exit(0);
  };

  process.on('SIGTERM', dump);
  process.on('SIGINT', dump);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
