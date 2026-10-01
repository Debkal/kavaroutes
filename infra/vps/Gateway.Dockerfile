FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
COPY scripts/check-web-bundles.mjs ./scripts/check-web-bundles.mjs
RUN npm ci --workspace=packages --workspace=@kavaroutes/web --include-workspace-root --ignore-scripts \
    && ./node_modules/.bin/tsc -b packages/*
ARG KR_BUILD_ID
RUN test -n "$KR_BUILD_ID" \
    && VITE_KAVAROUTES_BACKEND=private-cloud npm run build --workspace=@kavaroutes/web \
    && npm run build:driver --workspace=@kavaroutes/web \
    && node scripts/check-web-bundles.mjs

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/apps/web/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist-driver ./dist-driver
# This historically named module is the maintained business-authenticated gateway.
COPY --chown=node:node infra/gcp/runtime/prototype-web-gateway.mjs infra/gcp/runtime/driver-gateway-policy.mjs infra/gcp/runtime/driver-business-gate.mjs infra/gcp/runtime/driver-access-store.mjs ./
COPY --chown=node:node infra/vps/health.mjs ./health.mjs
USER node
CMD ["node", "prototype-web-gateway.mjs"]
