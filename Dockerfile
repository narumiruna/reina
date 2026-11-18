FROM docker:29.9.3-cli@sha256:5a7af0dcb0e46c803efe9b45371dd21cb500e5b4453250394ac6f06d49b6e6f1 AS docker-cli

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts/build-web.mjs ./scripts/build-web.mjs
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ENV NODE_ENV=production \
    REINA_STATE_DIR=/var/lib/reina \
    TMPDIR=/var/lib/reina-tmp \
    DOCKER_HOST=unix:///var/run/docker.sock
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY public ./public
COPY scripts/container-entrypoint.sh scripts/prepare-worker.mjs ./scripts/
COPY worker ./worker
RUN install -d -m 700 /var/lib/reina /var/lib/reina-tmp
ENTRYPOINT ["sh", "/app/scripts/container-entrypoint.sh"]
CMD ["node", "dist/index.js"]
