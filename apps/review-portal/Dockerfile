# syntax=docker/dockerfile:1
# Build stage: compile the static bundle. Configuration is NOT baked in; it is injected at start-up.
FROM node:25-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# Runtime stage: unprivileged nginx serving static files with SPA fallback.
FROM nginxinc/nginx-unprivileged:1.27-alpine
USER root
RUN mkdir -p /usr/share/nginx/runtime /etc/nginx/snippets \
 && chown -R 101:0 /usr/share/nginx/runtime \
 && chmod -R g+w /usr/share/nginx/runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --chmod=0755 docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
