# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1.4.2 AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev /temp/prod
COPY package.json bun.lock /temp/dev/
COPY package.json bun.lock /temp/prod/
WORKDIR /temp/dev
RUN bun install --frozen-lockfile
WORKDIR /temp/prod
RUN bun install --production --frozen-lockfile

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# copy production dependencies and source code into final image
FROM oven/bun:1.4.2-slim AS release
WORKDIR /usr/src/app

# Accept build arguments
ARG BUILD_VERSION
ARG BUILD_COMMIT

COPY --from=install --chown=bun /temp/prod/node_modules node_modules
COPY --from=prerelease --chown=bun /usr/src/app/src ./src
COPY --from=prerelease --chown=bun /usr/src/app/migrations ./migrations
COPY --from=prerelease --chown=bun /usr/src/app/tsconfig.json .
COPY --from=prerelease --chown=bun /usr/src/app/package.json .

# Set environment variables from build args
ENV BUILD_VERSION=${BUILD_VERSION}
ENV BUILD_COMMIT=${BUILD_COMMIT}

# run the app
USER bun
ENV PORT=3000
EXPOSE ${PORT}
CMD [ "bun", "run", "src/index.ts" ]
