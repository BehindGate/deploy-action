# The Bitbucket Pipe.
#
# A Pipe is a Docker image Bitbucket runs with the build directory mounted and
# pipe variables injected as environment variables. Because the image carries
# its own filesystem, this wrapper reuses src/core/ exactly as the Action does
# -- the GitLab component cannot, which is why that one is shell.
#
#   docker build -t behindgate/deploy-pipe:dev .
#
# Multi-arch: TARGETARCH is set by BuildKit and matches the vendor's own
# platform tokens (amd64, arm64), so it needs no translation.

FROM node:24-alpine AS cli

ARG TARGETARCH=amd64
WORKDIR /build

COPY versions.json ./
COPY src/core ./src/core
COPY script/fetch-cli.js ./script/

# Baked at build time, verified against the committed pin here AND again at run
# time. Storing the archive rather than the unpacked binary keeps one code path
# for baked and downloaded archives, and means an image altered after its build
# is caught by the same check that catches a tampered download.
RUN node script/fetch-cli.js --platform "linux-${TARGETARCH}"

FROM node:24-alpine

COPY --from=cli /opt/bg-deploy /opt/bg-deploy

WORKDIR /pipe
COPY versions.json ./
COPY src/core ./src/core
COPY src/bitbucket ./src/bitbucket
COPY pipe.yml LICENSE ./

# Unprivileged, which this pipe can afford because it never writes to the
# checkout. It reads the directory it is told to deploy and unpacks the CLI into
# a temporary directory of its own; nothing else touches the filesystem. `node`
# is provided by the base image (uid 1000).
USER node

# No WORKDIR games at run time: the entrypoint chdirs to BITBUCKET_CLONE_DIR, so
# a relative DEPLOY_PATH resolves against the checkout rather than against this.
ENTRYPOINT ["node", "/pipe/src/bitbucket/index.js"]
