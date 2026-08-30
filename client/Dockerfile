# `deps` is also the dev-mode target (docker-compose.dev.yml): it has the full
# dependency tree including vite, but no source — dev bind-mounts that in.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN npm ci --workspace client --include-workspace-root

FROM deps AS build
COPY client ./client
RUN npm run build --workspace client

FROM nginx:1.27-alpine AS runtime
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
