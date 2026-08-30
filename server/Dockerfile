# `deps` is also the dev-mode target (docker-compose.dev.yml): it has the full
# dependency tree including tsx, but no source — dev bind-mounts that in.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
# The client workspace is not needed to build the API, but npm needs its
# manifest present to resolve the workspace tree from the root lockfile.
RUN npm ci --workspace server --include-workspace-root

FROM deps AS build
COPY server ./server
RUN npm run build --workspace server

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci --omit=dev --workspace server --include-workspace-root && npm cache clean --force
# dist holds both the API entry point and the compiled CLI, so admin bootstrap
# and password reset (FR-1/FR-2) work in this image without dev dependencies:
#   docker compose exec api node server/dist/cli/index.js create-admin …
COPY --from=build /app/server/dist ./server/dist

USER node
EXPOSE 4000
CMD ["node", "server/dist/index.js"]
