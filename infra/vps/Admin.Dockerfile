FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/admin ./apps/admin
RUN npm ci --workspace=@kavaroutes/admin --include-workspace-root=false --omit=dev --ignore-scripts \
    && npm run build --workspace=@kavaroutes/admin

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
WORKDIR /app/apps/admin
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/apps/admin/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/admin/src ./src
COPY --from=build --chown=node:node /app/apps/admin/bin ./bin
COPY --from=build --chown=node:node /app/apps/admin/public ./public
COPY --chown=node:node infra/vps/health.mjs /app/health.mjs
USER node
CMD ["node", "src/main.mjs", "/var/lib/kavaroutes-admin/config.json"]
