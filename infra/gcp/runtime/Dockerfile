FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY vendor ./vendor
COPY infra/gcp/runtime ./infra/gcp/runtime
RUN npm ci --workspace=packages --include-workspace-root --ignore-scripts \
    && ./node_modules/.bin/tsc -b packages/* \
    && npm prune --omit=dev --workspace=packages --include-workspace-root --ignore-scripts \
    && node infra/gcp/runtime/stage-image.mjs

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
WORKDIR /app
# This is deliberately a synthetic development image, not a production profile.
ENV NODE_ENV=development
COPY --from=build --chown=node:node /stage/ ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/vendor ./vendor
USER node
HEALTHCHECK --interval=10s --timeout=5s --retries=3 CMD ["node", "infra/gcp/runtime/health.mjs", "58080"]
ENTRYPOINT ["node", "infra/gcp/runtime/main.mjs"]
CMD ["api", "/run/secrets/api.json"]
