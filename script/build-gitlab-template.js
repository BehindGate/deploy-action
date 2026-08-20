#!/usr/bin/env node
'use strict';

/**
 * Build the GitLab CI/CD component from its sources.
 *
 *   node script/build-gitlab-template.js          # rewrite the generated files
 *   node script/build-gitlab-template.js --check  # fail if either is stale
 *
 * Two files are generated, in two steps:
 *
 *   versions.json and src/core/environments.js
 *       -> the pin table and the environment table, inlined into
 *          src/gitlab/deploy.sh
 *   src/gitlab/deploy.sh
 *       -> the script body, spliced into templates/deploy.yml
 *
 * WHY THE PINS ARE INLINED. A component is YAML that GitLab merges into the
 * including project's pipeline; this repository is never checked out on the
 * runner, so the component cannot read versions.json at job time the way the
 * Action can. The checksums therefore have to live inside the shipped file --
 * and a table maintained by hand in two places is a table that will eventually
 * disagree with itself. Generating it keeps versions.json the single source.
 *
 * WHY THE SHELL IS A SEPARATE FILE. Shell embedded in YAML cannot be linted or
 * executed. Keeping it in src/gitlab/deploy.sh means `sh -n` checks it and the
 * integration tests run it exactly as shipped.
 *
 * This mirrors how dist/ is handled for the Action: committed output, rebuilt
 * from source, with CI refusing any diff.
 */

const fs = require('node:fs');
const path = require('node:path');

const environments = require('../src/core/environments');

const ROOT = path.join(__dirname, '..');
const TABLE_PATH = path.join(ROOT, 'versions.json');
const SCRIPT_PATH = path.join(ROOT, 'src', 'gitlab', 'deploy.sh');
const COMPONENT_PATH = path.join(ROOT, 'src', 'gitlab', 'component.yml');
const TEMPLATE_PATH = path.join(ROOT, 'templates', 'deploy.yml');

const PINS_BEGIN = '# >>> BEGIN generated from versions.json by script/build-gitlab-template.js';
const PINS_END = '# <<< END generated';
const BODY_BEGIN =
  '# >>> BEGIN generated from src/gitlab/deploy.sh by script/build-gitlab-template.js';
const BODY_END = '# <<< END generated';

/**
 * Platforms the component's shell can actually install on.
 *
 * Deliberately narrower than the Action's list. GitLab's Windows runners use
 * PowerShell rather than a POSIX shell, so a windows-* pin here would be a
 * checksum for an archive this script could never fetch -- worse than absent,
 * because it would read as support.
 */
const PLATFORMS = Object.freeze(['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64']);

/**
 * The first CLI release that can exchange a CI OIDC token.
 *
 * Earlier ones read `BEHINDGATE_TOKEN` and nothing else, and report its absence
 * as a bare exit 2 -- so without this check "no deploy token" is what a job sees
 * when a deploy token was never the plan.
 */
const OIDC_MIN_VERSION = '2026.8.5';

/**
 * The path the deploy endpoint sits at, below a BehindGate origin.
 *
 * The RELEASES collection specifically. The CLI posts here to create a release
 * and derives its siblings by trimming the last segment -- `/api/deploy/oidc/token`
 * for the credential exchange, which is the one this component depends on.
 */
const DEPLOY_PATH = '/api/deploy/releases';

/**
 * The management-plane origin of an environment: scheme and host of its
 * dashboard, which is also the audience its CI trust requires.
 */
function originOf(environment) {
  return new URL(environment.deployUrl).origin;
}

/**
 * Sort two of the vendor's calendar versions.
 *
 * They are not semver -- `2026.8.10` has to sort above `2026.8.9` -- so compare
 * the dot-separated components numerically rather than as strings.
 */
function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The pinned versions that can exchange an OIDC token, oldest first. */
function oidcCapableVersions(table) {
  return Object.keys(table.versions)
    .filter((version) => compareVersions(version, OIDC_MIN_VERSION) >= 0)
    .sort(compareVersions);
}

/**
 * Every generated value lands inside single quotes in POSIX shell, which has no
 * escape for a single quote. Version strings, hostnames, archive names and hex
 * digests all pass, so this should never fire -- it exists so that the day one
 * does not, the build fails here instead of emitting malformed shell.
 */
function shellSafe(value, what) {
  const text = String(value);
  if (!/^[A-Za-z0-9._:/-]+$/.test(text)) {
    throw new Error(
      `Refusing to embed ${what} ("${text}") in the component: it contains ` +
        `characters that would need quoting in POSIX shell.`
    );
  }
  return text;
}

/**
 * The shell origin table.
 *
 * The component has no `env` input. Under OIDC there is no deploy token to
 * carry the endpoint, so the CLI requires one to be named -- and the audience
 * the job asks GitLab to mint its token for is that endpoint's origin. A single
 * `app-origin` input therefore fixes all three: audience, deploy endpoint and
 * download host.
 *
 * What this table adds is the one thing that does NOT follow from the origin --
 * whether the host publishes a version once or republishes it -- and a build-time
 * check that the derived addresses match what src/core/environments.js records,
 * so the component and the Action cannot come to disagree about where a
 * published environment lives.
 */
function generateOrigins(table = environments.ENVIRONMENTS) {
  const cases = [];

  for (const [name, environment] of Object.entries(table)) {
    const origin = originOf(environment);

    if (`${origin}${DEPLOY_PATH}` !== environment.deployUrl) {
      throw new Error(
        `The ${name} environment deploys to ${environment.deployUrl}, which is not ` +
          `its origin plus ${DEPLOY_PATH}. The GitLab component derives the endpoint ` +
          `from \`app-origin\`, so this environment could not be reached that way.`
      );
    }

    if (origin !== environment.downloadBaseUrl) {
      throw new Error(
        `The ${name} environment downloads the CLI from ${environment.downloadBaseUrl} ` +
          `but deploys to ${origin}. The GitLab component derives both from ` +
          `\`app-origin\`, which cannot express a split like that.`
      );
    }

    cases.push(
      `    '${shellSafe(origin, 'an origin')}') printf '%s\\n' ` +
        `'${environment.pinnedCli ? 'pinned' : 'unpinned'}' ;;`
    );
  }

  return [
    `BG_DEPLOY_PATH='${shellSafe(DEPLOY_PATH, 'the deploy path')}'`,
    `BG_DEFAULT_ORIGIN='${shellSafe(originOf(table[environments.DEFAULT_ENVIRONMENT]), 'the default origin')}'`,
    `BG_KNOWN_ORIGINS='${Object.values(table)
      .map((e) => shellSafe(originOf(e), 'an origin'))
      .join(' ')}'`,
    '',
    '# Prints "pinned" or "unpinned" for an origin this repository names.',
    'bg_origin() {',
    '  case "$1" in',
    ...cases,
    '    *) return 1 ;;',
    '  esac',
    '}',
  ];
}

/** The shell pin table: a lookup from version/platform to archive, binary, digest. */
function generatePins(table) {
  const versions = Object.keys(table.versions);
  const cases = [];

  for (const version of versions) {
    for (const platform of PLATFORMS) {
      const artifact = table.versions[version].platforms[platform];

      if (!artifact) {
        throw new Error(
          `versions.json pins no "${platform}" artifact for ${version}, but the ` +
            `GitLab component installs on that platform. Add it, or drop the ` +
            `platform from PLATFORMS in this script.`
        );
      }

      if (!artifact.archive.endsWith('.tar.gz')) {
        throw new Error(
          `${version}/${platform} pins "${artifact.archive}", which the component ` +
            `cannot unpack -- its shell handles .tar.gz only.`
        );
      }

      cases.push(
        `    '${shellSafe(version, 'a version')}/${platform}') printf '%s %s %s\\n' ` +
          `'${shellSafe(artifact.archive, 'an archive name')}' ` +
          `'${shellSafe(artifact.binary, 'a binary name')}' ` +
          `'${shellSafe(artifact.sha256, 'a checksum')}' ;;`
      );
    }
  }

  const oidcCapable = oidcCapableVersions(table);

  if (!oidcCapable.length) {
    throw new Error(
      `versions.json pins nothing at or above ${OIDC_MIN_VERSION}, so no pinned ` +
        `CLI can exchange an OIDC token -- which is how this component ` +
        `authenticates by default. Pin ${OIDC_MIN_VERSION} or newer.`
    );
  }

  return [
    // The component authenticates with OIDC unless a deploy token is set, so its
    // default has to be a release that can do that. versions.json's own
    // `defaultVersion` belongs to the Action, which still has the deploy token as
    // its default path and must keep defaulting to what production serves.
    `BG_DEFAULT_VERSION='${shellSafe(oidcCapable[oidcCapable.length - 1], 'the default version')}'`,
    `BG_PINNED_VERSIONS='${versions.map((v) => shellSafe(v, 'a version')).join(' ')}'`,
    `BG_OIDC_MIN_VERSION='${shellSafe(OIDC_MIN_VERSION, 'the minimum OIDC version')}'`,
    `BG_OIDC_VERSIONS='${oidcCapable.map((v) => shellSafe(v, 'a version')).join(' ')}'`,
    '',
    '# Prints "<archive> <binary> <sha256>" for a version/platform pair.',
    'bg_pin() {',
    '  case "$1/$2" in',
    ...cases,
    '    *) return 1 ;;',
    '  esac',
    '}',
  ];
}

/**
 * Splice lines between two markers, preserving the indentation the markers sit
 * at. The YAML side puts them inside a block scalar, so getting the indentation
 * wrong would produce perfectly valid YAML containing broken shell.
 */
function splice(source, { begin, end, lines, what }) {
  const existing = source.split('\n');
  const from = existing.findIndex((line) => line.trim() === begin);
  const to = existing.findIndex((line, index) => index > from && line.trim() === end);

  if (from === -1 || to === -1) {
    throw new Error(
      `${what} has no generated region. It must contain a line "${begin}" ` +
        `followed by a line "${end}".`
    );
  }

  const indent = existing[from].slice(0, existing[from].indexOf('#'));
  const body = lines.map((line) => (line ? `${indent}${line}` : ''));

  return [...existing.slice(0, from + 1), ...body, ...existing.slice(to)].join('\n');
}

/**
 * Read a source file as LF-terminated text.
 *
 * `.gitattributes` checks these files out with LF everywhere, but a working
 * copy created before that -- or one whose Git is configured otherwise -- can
 * still hold CRLF. Splicing generated LF lines into CRLF ones would produce a
 * file with mixed endings that differs from the committed one on Windows only,
 * so normalise on the way in and always write LF.
 */
function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Drop the shebang: inside the YAML block scalar it would only be a comment. */
function scriptBody(script) {
  const lines = script.replace(/\n+$/, '').split('\n');
  return lines[0].startsWith('#!') ? lines.slice(1) : lines;
}

function build() {
  const table = JSON.parse(readText(TABLE_PATH));

  const script = splice(readText(SCRIPT_PATH), {
    begin: PINS_BEGIN,
    end: PINS_END,
    lines: [...generateOrigins(), '', ...generatePins(table)],
    what: 'src/gitlab/deploy.sh',
  });

  const template = splice(readText(COMPONENT_PATH), {
    begin: BODY_BEGIN,
    end: BODY_END,
    lines: scriptBody(script),
    what: 'src/gitlab/component.yml',
  });

  return [
    { path: SCRIPT_PATH, label: 'src/gitlab/deploy.sh', next: script },
    { path: TEMPLATE_PATH, label: 'templates/deploy.yml', next: template },
  ];
}

function main() {
  const check = process.argv.includes('--check');
  const stale = [];

  for (const output of build()) {
    const current = fs.existsSync(output.path) ? readText(output.path) : null;
    if (current === output.next) continue;

    if (check) {
      stale.push(output.label);
    } else {
      fs.mkdirSync(path.dirname(output.path), { recursive: true });
      fs.writeFileSync(output.path, output.next);
      console.log(`Wrote ${output.label}.`);
    }
  }

  if (stale.length) {
    console.error(
      `${stale.join(' and ')} ${stale.length > 1 ? 'are' : 'is'} out of date.\n` +
        `Run 'npm run build:gitlab' and commit the result.`
    );
    process.exit(1);
  }

  console.log(
    check
      ? 'The GitLab component is in sync with versions.json and src/gitlab/.'
      : 'The GitLab component is up to date.'
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  build,
  generatePins,
  generateOrigins,
  oidcCapableVersions,
  compareVersions,
  splice,
  scriptBody,
  readText,
  PLATFORMS,
  OIDC_MIN_VERSION,
  DEPLOY_PATH,
};
