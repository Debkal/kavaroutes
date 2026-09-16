FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY vendor ./vendor
COPY apps/web ./apps/web
RUN npm ci --workspace=packages --workspace=@kavaroutes/web --include-workspace-root --ignore-scripts \
    && ./node_modules/.bin/tsc -b packages/* \
    && VITE_KAVAROUTES_BACKEND=private-cloud npm run build --workspace=@kavaroutes/web

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/dist ./public
COPY --chown=node:node infra/local/server.mjs ./server.mjs
USER node
CMD ["node", "/app/server.mjs"]
