FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/site ./apps/site
RUN npm ci --workspace=@kavaroutes/site --include-workspace-root --ignore-scripts \
    && npm run build --workspace=@kavaroutes/site

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/site/package.json ./apps/site/package.json
RUN npm ci --workspace=@kavaroutes/site --include-workspace-root=false --omit=dev --ignore-scripts

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
WORKDIR /app/apps/site
ENV NODE_ENV=production
COPY --from=dependencies --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/site/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/site/dist ./dist
COPY --from=build --chown=node:node /app/apps/site/server ./server
COPY --chown=node:node infra/vps/health.mjs /app/health.mjs
USER node
CMD ["node", "server/main.mjs"]
